import { touchChanged } from "./changeTracker.js";

// 주 단위 정렬 기준 월요일 (기존 로테이션 기준일). weekStart 검증과 "다음 주" 계산에 사용.
const ANCHOR_MONDAY = "2026-09-07";
const WEEKDAY_ORDER = ["월", "화", "수", "목", "금", "토", "일"];

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// 기존 근무 원본 (12/07 이전 주에 사용)
const ROSTER_OLD = {
  anchorMonday: ANCHOR_MONDAY,
  groupA: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  groupB: range(20, 36),
  anchorTable: "anchor_week",
  templateTable: "seat_template",
};
// 새 근무 원본 (2026-12-07 주부터 사용, 웹앱샘플시간표.xlsx 기준)
const ROSTER_V2_START = "2026-12-07";
const ROSTER_V2 = {
  anchorMonday: ROSTER_V2_START,
  groupA: range(1, 18),
  groupB: range(19, 34),
  anchorTable: "anchor_week_v2",
  templateTable: "seat_template_v2",
};
function rosterFor(monday) {
  return monday >= ROSTER_V2_START ? ROSTER_V2 : ROSTER_OLD;
}

function dateAdd(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
function advanceSeat(seat, steps, group, roster) {
  const order = group === "A" ? roster.groupA : roster.groupB;
  const idx = order.indexOf(seat);
  if (idx === -1) return seat;
  const n = order.length;
  return order[((idx + steps) % n + n) % n];
}

export async function handleGenerateNextWeek(request, env) {
  if (!env.ADMIN_PIN) {
    return Response.json({ error: "관리자 기능이 아직 설정되지 않았어요 (ADMIN_PIN 미설정)." }, { status: 500 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 형식이에요." }, { status: 400 });
  }
  if (!body.pin || body.pin !== env.ADMIN_PIN) {
    return Response.json({ error: "비밀번호가 올바르지 않아요." }, { status: 403 });
  }

  const db = env.DB;

  let nextMonday;
  if (body.weekStart) {
    // 복구용: 지정한 주(월요일)를 생성한다.
    // 로테이션이 ANCHOR_MONDAY 기준으로 계산되므로, 중간 주가 비어 있어도
    // 원하는 주만 골라서 만들 수 있다.
    const ws = String(body.weekStart);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) {
      return Response.json({ error: "weekStart는 YYYY-MM-DD 형식이어야 해요." }, { status: 400 });
    }
    const diff = daysBetween(ANCHOR_MONDAY, ws);
    if (diff < 0 || diff % 7 !== 0) {
      return Response.json(
        { error: `weekStart는 ${ANCHOR_MONDAY} 이후의 근무표 기준 월요일 날짜여야 해요.` },
        { status: 400 }
      );
    }
    nextMonday = ws;
  } else {
    // Only count a date as a real "generated day" if it has a substantial
    // number of rows — a sparse manual entry (leave set far in advance for
    // just one person) shouldn't be mistaken for an already-generated week.
    const lastRow = await db
      .prepare(
        "SELECT MAX(date) as maxDate FROM (SELECT date, COUNT(*) as n FROM shifts GROUP BY date HAVING n > 5)"
      )
      .first();
    const lastDate = lastRow && lastRow.maxDate;
    if (!lastDate) {
      return Response.json({ error: "기준이 될 근무 데이터가 없어요." }, { status: 400 });
    }

    // Round up to the next full Monday-start week boundary relative to the
    // anchor, rather than just "lastDate + 1" — a sparse future date (e.g. a
    // leave entry set far in advance) can otherwise push lastDate past the
    // actual latest generated week and throw this off.
    const weekOffsetOfLastDate = Math.floor(daysBetween(ANCHOR_MONDAY, lastDate) / 7);
    nextMonday = dateAdd(ANCHOR_MONDAY, (weekOffsetOfLastDate + 1) * 7);
  }

  const exists = await db.prepare("SELECT COUNT(*) as n FROM shifts WHERE date = ?").bind(nextMonday).first();
  // A handful of rows can come from a manually-set entry (leave, edit) made
  // in advance for that date — only a week that's actually been generated
  // has a full day's worth of rows, so use a threshold rather than any row.
  if (exists && exists.n > 5) {
    return Response.json({ error: `${nextMonday} 주는 이미 생성되어 있어요.`, alreadyExists: true }, { status: 409 });
  }

  const roster = rosterFor(nextMonday);
  const weekOffset = Math.round(daysBetween(roster.anchorMonday, nextMonday) / 7);
  const weekDates = WEEKDAY_ORDER.map((_, i) => dateAdd(nextMonday, i));

  const [employeesRes, anchorRes, templateRes, codeRes] = await Promise.all([
    db.prepare("SELECT id, name FROM employees WHERE active = 1").all(),
    db.prepare(`SELECT emp_id, seat, grp FROM ${roster.anchorTable}`).all(),
    db.prepare(`SELECT seat, dow, period, code FROM ${roster.templateTable}`).all(),
    db.prepare("SELECT code, day_label, night_label FROM code_table").all(),
  ]);

  const anchorByEmp = {};
  for (const r of anchorRes.results) anchorByEmp[r.emp_id] = { seat: r.seat, group: r.grp };

  const template = {};
  for (const r of templateRes.results) {
    template[r.seat] = template[r.seat] || {};
    template[r.seat][r.dow] = r.period ? { period: r.period, code: r.code } : null;
  }

  const codeTable = {};
  for (const r of codeRes.results) codeTable[r.code] = { dayLabel: r.day_label, nightLabel: r.night_label };
  function labelFor(code, period) {
    const entry = codeTable[code];
    if (!entry) return code;
    return period === "주간" ? entry.dayLabel : entry.nightLabel || entry.dayLabel;
  }

  const rowsToInsert = [];
  for (const emp of employeesRes.results) {
    const anchor = anchorByEmp[emp.id];
    if (!anchor) continue;
    const seat = advanceSeat(anchor.seat, weekOffset, anchor.group, roster);
    const seatTemplate = template[seat] || {};
    WEEKDAY_ORDER.forEach((dow, i) => {
      const entry = seatTemplate[dow];
      if (!entry) return;
      rowsToInsert.push({
        date: weekDates[i],
        dow,
        empId: emp.id,
        empName: emp.name,
        period: entry.period,
        code: entry.code,
        label: labelFor(entry.code, entry.period),
      });
    });
  }

  if (rowsToInsert.length === 0) {
    return Response.json({ error: "생성할 근무가 없어요." }, { status: 400 });
  }

  const stmt = db.prepare(
    // OR IGNORE: a manually-set entry (e.g. leave scheduled in advance for
    // this date) already occupying that (date, emp_id) slot wins over the
    // auto-generated rotation code.
    "INSERT OR IGNORE INTO shifts (date, dow, emp_id, emp_name, period, code, label, swappable) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
  );
  const results = await db.batch(
    rowsToInsert.map((r) => stmt.bind(r.date, r.dow, r.empId, r.empName, r.period, r.code, r.label))
  );
  const actuallyInserted = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  const skipped = rowsToInsert.length - actuallyInserted;

  await touchChanged(db);

  return Response.json({
    inserted: actuallyInserted,
    skipped,
    weekStart: nextMonday,
    weekEnd: weekDates[6],
  });
}
