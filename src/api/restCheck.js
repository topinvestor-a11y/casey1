// Actual clock hours per shift code, used to compute real rest time between
// two adjacent-day shifts (not just a night/day heuristic). Minutes are
// minutes-from-midnight of the shift's own date; `crosses` means the shift
// ends after midnight, i.e. on the following calendar date.
const HOURS_TABLE = {
  "1": { day: [7 * 60, 19 * 60, false], night: [19 * 60, 7 * 60, true] },
  "1A": { day: [7 * 60, 19 * 60, false], night: [19 * 60, 7 * 60, true] },
  "1B": { day: [7 * 60, 19 * 60, false], night: [19 * 60, 7 * 60, true] },
  "1D": { day: [7 * 60, 19 * 60, false], night: [19 * 60, 7 * 60, true] },
  "3": { day: [7 * 60, 19 * 60, false], night: [19 * 60, 7 * 60, true] },
  "5": { day: [7 * 60, 19 * 60, false], night: [19 * 60, 7 * 60, true] },
  "5A": { day: [7 * 60, 19 * 60, false], night: [19 * 60, 7 * 60, true] },
  "1C": { day: [5 * 60, 15 * 60, false], night: [15 * 60, 1 * 60, true] },
  "3A": { day: [5 * 60, 15 * 60, false], night: [15 * 60, 1 * 60, true] },
  "3B": { day: [5 * 60, 15 * 60, false], night: [15 * 60, 20 * 60, false] },
  "R": { day: [11 * 60, 19 * 60, false], night: [21 * 60, 5 * 60, true] },
  "R1": { day: [11 * 60, 19 * 60, false], night: [21 * 60, 5 * 60, true] },
  "N": { day: [6 * 60, 18 * 60, false], night: null },
  "N1": { day: [6 * 60, 18 * 60, false], night: null },
};

const MIN_REST_HOURS = 12;

function getShiftBounds(code, period) {
  const entry = HOURS_TABLE[code];
  if (!entry) return null; // unknown code (e.g. 비번) — no time-based check
  const spec = period === "야간" ? entry.night : entry.day;
  if (!spec) return null;
  return { start: spec[0], end: spec[1], crosses: spec[2] };
}

// Rest hours between a shift ending on date D0 and a shift starting on the
// very next calendar date D0+1.
function restHoursBetweenAdjacentDays(code0, period0, code1, period1) {
  const b0 = getShiftBounds(code0, period0);
  const b1 = getShiftBounds(code1, period1);
  if (!b0 || !b1) return null;
  const endAbs = b0.end + (b0.crosses ? 1440 : 0);
  const startAbs = b1.start + 1440; // next date's midnight is +1440 minutes
  return (startAbs - endAbs) / 60;
}

function dateAddShared(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function formatDateShared(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

// Checks whether `empId` gaining (date, code, period) would leave less than
// 12 hours of rest against whatever they already have on the adjacent day
// (in either direction). Returns an error message string, or null if fine.
//
// Two rules, both kept:
// 1. The original rule — a 야간 shift immediately followed by a 주간 shift
//    the next day (or preceded by one) is blocked outright, regardless of
//    the exact hours, since that pattern is never acceptable here.
// 2. The newer rule — any other combination is checked against the real
//    clock hours for the codes involved, and blocked if it leaves under
//    12 hours of rest (this also catches 주간→주간 cases the old rule
//    didn't cover).
async function checkTwelveHourRest(db, empId, empName, date, code, period) {
  if (!code || code === "비번") return null;

  const nextDate = dateAddShared(date, 1);
  const next = await db
    .prepare("SELECT code, period FROM shifts WHERE date = ? AND emp_id = ?")
    .bind(nextDate, empId)
    .first();
  if (next) {
    if (period === "야간" && next.period === "주간") {
      return `${empName}님이 ${formatDateShared(nextDate)}에 주간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요. 교환할 수 없어요.`;
    }
    const rest = restHoursBetweenAdjacentDays(code, period, next.code, next.period);
    if (rest !== null && rest < MIN_REST_HOURS) {
      return `${empName}님이 ${formatDateShared(nextDate)}에 근무가 있어서, 퇴근 후 휴식이 ${rest}시간뿐이에요 (최소 ${MIN_REST_HOURS}시간 필요). 교환할 수 없어요.`;
    }
  }

  const prevDate = dateAddShared(date, -1);
  const prev = await db
    .prepare("SELECT code, period FROM shifts WHERE date = ? AND emp_id = ?")
    .bind(prevDate, empId)
    .first();
  if (prev) {
    if (prev.period === "야간" && period === "주간") {
      return `${empName}님이 ${formatDateShared(prevDate)}에 야간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요. 교환할 수 없어요.`;
    }
    const rest = restHoursBetweenAdjacentDays(prev.code, prev.period, code, period);
    if (rest !== null && rest < MIN_REST_HOURS) {
      return `${empName}님이 ${formatDateShared(prevDate)} 근무 이후 휴식이 ${rest}시간뿐이에요 (최소 ${MIN_REST_HOURS}시간 필요). 교환할 수 없어요.`;
    }
  }

  return null;
}

export { HOURS_TABLE, MIN_REST_HOURS, getShiftBounds, restHoursBetweenAdjacentDays, checkTwelveHourRest };
