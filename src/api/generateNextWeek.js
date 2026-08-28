const ANCHOR_MONDAY = "2026-09-07";
const GROUP_A_SEATS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
const GROUP_B_SEATS = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];
const WEEKDAY_ORDER = ["월", "화", "수", "목", "금", "토", "일"];

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
function advanceSeat(seat, steps, group) {
  const order = group === "A" ? GROUP_A_SEATS : GROUP_B_SEATS;
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
  const nextMonday = dateAdd(ANCHOR_MONDAY, (weekOffsetOfLastDate + 1) * 7);
  const exists = await db.prepare("SELECT COUNT(*) as n FROM shifts WHERE date = ?").bind(nextMonday).first();
  // A handful of rows can come from a manually-set entry (leave, edit) made
  // in advance for that date — only a week that's actually been generated
  // has a full day's worth of rows, so use a threshold rather than any row.
  if (exists && exists.n > 5) {
    return Response.json({ error: `${nextMonday} 주는 이미 생성되어 있어요.`, alreadyExists: true }, { status: 409 });
  }

  const weekOffset = Math.round(daysBetween(ANCHOR_MONDAY, nextMonday) / 7);
  const weekDates = WEEKDAY_ORDER.map((_, i) => dateAdd(nextMonday, i));

  const [employeesRes, anchorRes, templateRes, codeRes] = await Promise.all([
    db.prepare("SELECT id, name FROM employees WHERE active = 1").all(),
    db.prepare("SELECT emp_id, seat, grp FROM anchor_week").all(),
    db.prepare("SELECT seat, dow, period, code FROM seat_template").all(),
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
    const seat = advanceSeat(anchor.seat, weekOffset, anchor.group);
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

  return Response.json({
    inserted: actuallyInserted,
    skipped,
    weekStart: nextMonday,
    weekEnd: weekDates[6],
  });
}
