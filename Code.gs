/**
 * DYNAFIT 근무시간 앱 — Google Apps Script 서버 코드
 * 기존 "2026 근무시간표_DYNAFIT" 시트의 월별 탭(YY-MM월 근무시간)에 직접 기록합니다.
 *
 * 시트 구조 (기존 양식 그대로)
 *   B: 날짜 | C: 출근 | D: 퇴근 | E: 시간(±) | F: 주간 합계(병합) | G: 메모
 *   1행 제목, 2행 헤더, 3행부터 날짜
 *
 * 계산 규칙 (기존 기록 36건으로 검증)
 *   - 출근: 30분 단위 올림, 단 정각/반 기준 5분 이내는 내림 (9:04→9:00, 9:07→9:30)
 *   - 퇴근: 30분 단위 내림 (18:41→18:30)
 *   - 시간 = (퇴근 - 출근) - 9시간 (점심 포함 기준), 반차는 -4시간 기준
 */

// ===== 설정 =====
const SPREADSHEET_ID = '13rlJpgXyPd04nAD396MD-WTtjT5_-bpcCJs24Iuhh7U';
const TZ = 'Asia/Seoul';
const GRACE_MIN = 5;      // 출근 유예(분)
const BASE_HOURS = 9;     // 기준 근무시간(점심 포함)
const HALF_HOURS = 4;     // 반차 기준 근무시간
const FIRST_ROW = 3;
const COL = { date: 2, in: 3, out: 4, hours: 5, week: 6, memo: 7 };

// 휴가/휴일 종류 → 시트에 병합되어 표시될 라벨
const LEAVE_TYPES = ['연차', '공휴일', '대체휴일', '출장', '교육', '산행', '워크샵', '경조사', '기타'];

// ===== 웹앱 진입점 =====
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('DYNAFIT 근무')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== 클라이언트에서 호출하는 API =====

/** 월 데이터 + 오늘 상태 */
function getMonth(year, month) {
  const now = new Date();
  if (!year) { year = Number(fmt(now, 'yyyy')); month = Number(fmt(now, 'M')); }
  const sh = getMonthSheet(year, month, false);
  const result = {
    year: year, month: month,
    today: fmt(now, 'yyyy-MM-dd'),
    nowTime: fmt(now, 'H:mm'),
    sheetName: sheetNameOf(year, month),
    exists: !!sh,
    rows: [],
    leaveTypes: LEAVE_TYPES,
    rule: { grace: GRACE_MIN, base: BASE_HOURS, half: HALF_HOURS }
  };
  if (!sh) return result;

  const last = Math.max(sh.getLastRow(), FIRST_ROW);
  const n = last - FIRST_ROW + 1;
  const rng = sh.getRange(FIRST_ROW, COL.date, n, 6); // B..G
  const vals = rng.getValues();
  const disp = rng.getDisplayValues();
  const merges = sh.getRange(FIRST_ROW, COL.in, n, 3).getMergedRanges();
  const mergedRows = {};
  merges.forEach(m => { for (let r = m.getRow(); r <= m.getLastRow(); r++) mergedRows[r] = true; });

  for (let i = 0; i < n; i++) {
    const d = vals[i][0];
    if (!(d instanceof Date)) continue;
    const row = FIRST_ROW + i;
    const inD = disp[i][1], outD = disp[i][2], hrD = disp[i][3], memo = disp[i][5];
    let label = '';
    if (mergedRows[row] || (inD && !/^\d{1,2}:\d{2}/.test(inD) && inD !== '-')) {
      label = String(inD).replace(/^\*/, '').trim();
    }
    const h = parseFloat(hrD);
    result.rows.push({
      row: row,
      date: fmt(d, 'yyyy-MM-dd'),
      dow: Number(fmt(d, 'u')) % 7, // 0=일
      in: label ? '' : inD,
      out: label ? '' : outD,
      hours: isNaN(h) ? null : h,
      label: label,
      memo: memo
    });
  }
  return result;
}

/** 지금 시각으로 출근 */
function clockIn() {
  const now = new Date();
  return saveEntry(fmt(now, 'yyyy-MM-dd'), fmt(now, 'H:mm'), null, null);
}

/** 지금 시각으로 퇴근 */
function clockOut() {
  const now = new Date();
  return saveEntry(fmt(now, 'yyyy-MM-dd'), null, fmt(now, 'H:mm'), null);
}

/**
 * 날짜별 저장
 * @param {string} dateStr yyyy-MM-dd
 * @param {string|null} inT  'H:mm' (null=변경 안 함, ''=지움)
 * @param {string|null} outT 'H:mm'
 * @param {object|null} opt  { kind: 'work'|'am'|'pm'|'leave', label, memo }
 */
function saveEntry(dateStr, inT, outT, opt) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    opt = opt || {};
    const p = dateStr.split('-').map(Number);
    const sh = getMonthSheet(p[0], p[1], true);
    const row = findRow(sh, dateStr);
    if (!row) throw new Error(dateStr + ' 날짜 행을 찾지 못했어요.');

    const kind = opt.kind || 'work';

    // 휴가/휴일: C:E 병합 + 라벨
    if (kind === 'leave') {
      const r = sh.getRange(row, COL.in, 1, 3);
      r.breakApart().clearContent();
      r.merge().setValue('*' + (opt.label || '연차')).setHorizontalAlignment('center');
      if (opt.memo !== undefined) sh.getRange(row, COL.memo).setValue(opt.memo || '');
      SpreadsheetApp.flush();
      return getMonth(p[0], p[1]);
    }

    // 근무일: 병합되어 있으면 해제
    const block = sh.getRange(row, COL.in, 1, 3);
    if (block.isPartOfMerge()) { block.breakApart(); block.clearContent(); }

    const inCell = sh.getRange(row, COL.in);
    const outCell = sh.getRange(row, COL.out);
    const hrCell = sh.getRange(row, COL.hours);

    if (inT !== null && inT !== undefined) inCell.setValue(inT ? inT : '');
    if (outT !== null && outT !== undefined) outCell.setValue(outT ? outT : '');
    if (inT || outT) { inCell.setNumberFormat('H:mm'); outCell.setNumberFormat('H:mm'); }

    // 반차 메모
    let memo = opt.memo;
    if (kind === 'am') memo = '*오전반차' + (opt.memo ? ' ' + opt.memo : '');
    if (kind === 'pm') memo = '*오후반차' + (opt.memo ? ' ' + opt.memo : '');
    if (memo !== undefined && memo !== null) sh.getRange(row, COL.memo).setValue(memo);

    // 시간(±) 계산: E열에 수식이 있으면 그대로 두고, 값이면 앱이 계산해서 기록
    const curIn = toHM(inCell.getDisplayValue());
    const curOut = toHM(outCell.getDisplayValue());
    const hasFormula = !!hrCell.getFormula();
    const half = (kind === 'am' || kind === 'pm');
    if (!hasFormula || half) {
      if (curIn && curOut) hrCell.setValue(calcHours(curIn, curOut, half));
      else if (!hasFormula) hrCell.clearContent();
    }

    ensureWeekFormula(sh, row);
    SpreadsheetApp.flush();
    return getMonth(p[0], p[1]);
  } finally {
    lock.releaseLock();
  }
}

/** 해당 날짜 기록 지우기 */
function clearEntry(dateStr) {
  const p = dateStr.split('-').map(Number);
  const sh = getMonthSheet(p[0], p[1], false);
  if (!sh) return getMonth(p[0], p[1]);
  const row = findRow(sh, dateStr);
  if (row) {
    const block = sh.getRange(row, COL.in, 1, 3);
    if (block.isPartOfMerge()) block.breakApart();
    const hr = sh.getRange(row, COL.hours);
    const f = hr.getFormula();
    sh.getRange(row, COL.in, 1, 2).clearContent();
    if (!f) hr.clearContent();
    sh.getRange(row, COL.memo).clearContent();
    SpreadsheetApp.flush();
  }
  return getMonth(p[0], p[1]);
}

// ===== 계산 =====
function calcHours(inT, outT, half) {
  let s = hmToMin(inT), e = hmToMin(outT);
  const r = s % 30;
  s = (r <= GRACE_MIN) ? s - r : s + (30 - r);
  e = e - (e % 30);
  return (e - s) / 60 - (half ? HALF_HOURS : BASE_HOURS);
}

// ===== 시트 도우미 =====
function sheetNameOf(y, m) {
  return String(y).slice(-2) + '-' + ('0' + m).slice(-2) + '월 근무시간';
}

function getMonthSheet(y, m, create) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(sheetNameOf(y, m));
  if (!sh && create) sh = createMonthSheet(ss, y, m);
  return sh;
}

function findRow(sh, dateStr) {
  const last = sh.getLastRow();
  if (last < FIRST_ROW) return null;
  const vals = sh.getRange(FIRST_ROW, COL.date, last - FIRST_ROW + 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    const d = vals[i][0];
    if (d instanceof Date && fmt(d, 'yyyy-MM-dd') === dateStr) return FIRST_ROW + i;
  }
  return null;
}

/** 새 달 탭이 없으면 가장 최근 달 탭을 복사해 만든다 (서식 유지, 날짜·주간합계 재구성) */
function createMonthSheet(ss, y, m) {
  const re = /^(\d{2})-(\d{2})월 근무시간$/;
  const tpl = ss.getSheets()
    .filter(s => re.test(s.getName()))
    .sort((a, b) => a.getName() < b.getName() ? 1 : -1)[0];
  if (!tpl) throw new Error('복사할 월 탭(YY-MM월 근무시간)이 없어요.');

  const sh = tpl.copyTo(ss).setName(sheetNameOf(y, m));
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);

  // 제목 월 바꾸기
  const title = sh.getRange(1, COL.date);
  title.setValue(String(title.getValue())
    .replace(/\d{2}\s*-\s*\d{1,2}(월?)/, String(y).slice(-2) + ' - ' + ('0' + m).slice(-2) + '$1'));

  // E열 수식 패턴 확보(있다면)
  const tplLast = Math.max(tpl.getLastRow(), FIRST_ROW);
  const eF = tpl.getRange(FIRST_ROW, COL.hours, tplLast - FIRST_ROW + 1, 1).getFormulasR1C1()
    .map(r => r[0]).filter(f => f);
  const eFormula = eF.length ? eF[0] : '';

  // 본문 초기화
  const maxRows = 31;
  const body = sh.getRange(FIRST_ROW, COL.date, maxRows + 2, 7);
  body.breakApart();
  sh.getRange(FIRST_ROW, COL.in, maxRows + 2, 6).clearContent();

  const days = new Date(y, m, 0).getDate();
  const dates = [];
  for (let d = 1; d <= maxRows; d++) dates.push([d <= days ? new Date(y, m - 1, d) : '']);
  sh.getRange(FIRST_ROW, COL.date, maxRows, 1).setValues(dates);

  // 평일 E 수식, 주간 합계 병합
  let weekStart = null;
  for (let d = 1; d <= days + 1; d++) {
    const row = FIRST_ROW + d - 1;
    const dow = d <= days ? new Date(y, m - 1, d).getDay() : 0;
    const weekday = d <= days && dow >= 1 && dow <= 5;
    if (weekday && eFormula) sh.getRange(row, COL.hours).setFormulaR1C1(eFormula);
    if (weekday && weekStart === null) weekStart = row;
    if ((!weekday || dow === 5) && weekStart !== null) {
      const end = weekday ? row : row - 1;
      const f = sh.getRange(weekStart, COL.week, end - weekStart + 1, 1);
      if (end > weekStart) f.merge();
      sh.getRange(weekStart, COL.week).setFormula('=SUM(E' + weekStart + ':E' + end + ')');
      weekStart = null;
    }
  }
  return sh;
}

/** 주간 합계 셀이 비어 있으면 수식을 채워 둔다 */
function ensureWeekFormula(sh, row) {
  const top = sh.getRange(row, COL.week).isPartOfMerge()
    ? sh.getRange(row, COL.week).getMergedRanges()[0].getCell(1, 1)
    : sh.getRange(row, COL.week);
  if (top.getFormula() || top.getValue() !== '') return;
  const merged = sh.getRange(row, COL.week).getMergedRanges()[0];
  const a = merged ? merged.getRow() : row, b = merged ? merged.getLastRow() : row;
  top.setFormula('=SUM(E' + a + ':E' + b + ')');
}

// ===== 유틸 =====
function fmt(d, p) { return Utilities.formatDate(d, TZ, p); }
function hmToMin(t) { const a = String(t).split(':').map(Number); return a[0] * 60 + a[1]; }
function toHM(s) { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? m[1] + ':' + m[2] : ''; }

/** 설치 확인용: 에디터에서 실행하면 권한 승인 + 이번 달 데이터 로그 */
function testSetup() {
  const r = getMonth();
  Logger.log(r.sheetName + ' / 행 수: ' + r.rows.length + ' / 탭 존재: ' + r.exists);
  Logger.log('계산 테스트 9:03~18:31 → ' + calcHours('9:03', '18:31') + ' (기대값 0.5)');
}
