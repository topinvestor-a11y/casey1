const SHIFT_WINDOW_DAYS = 30;

export async function handleBootstrap(env) {
  const db = env.DB;

  // Only load a rolling window of shifts/requests, not the entire table's
  // history — without this, every poll re-reads every week ever generated,
  // and that grows without bound as weeks pile up (this is what blew past
  // D1's free-tier daily row-read limit).
  const [employees, codeRows, shifts, requests, anchorRows] = await Promise.all([
    db.prepare("SELECT id, name, active FROM employees ORDER BY id").all(),
    db.prepare("SELECT code, day_label, night_label FROM code_table").all(),
    db
      .prepare(
        `SELECT date, dow, emp_id as empId, emp_name as empName, period, code, label, swappable
         FROM shifts
         WHERE date >= date('now', '-${SHIFT_WINDOW_DAYS} days')
         ORDER BY date, emp_id`
      )
      .all(),
    db
      .prepare(
        `SELECT id, created_at as createdAt, requester_id as requesterId, requester_name as requesterName,
                target_id as targetId, target_name as targetName,
                my_date as myDate, my_dow as myDow, my_code as myCode, my_period as myPeriod,
                target_date as targetDate, target_dow as targetDow, target_code as targetCode, target_period as targetPeriod,
                status, memo, processed_at as processedAt
         FROM swap_requests
         WHERE created_at >= datetime('now', '-${SHIFT_WINDOW_DAYS} days')
         ORDER BY created_at DESC`
      )
      .all(),
    db.prepare("SELECT emp_id, seat, grp FROM anchor_week").all(),
  ]);

  const codeTable = {};
  for (const r of codeRows.results) {
    codeTable[r.code] = { dayLabel: r.day_label, nightLabel: r.night_label };
  }

  const anchorByEmp = {};
  for (const r of anchorRows.results) {
    anchorByEmp[r.emp_id] = { seat: r.seat, group: r.grp };
  }

  return Response.json({
    employees: employees.results.map((e) => ({
      ...e,
      active: !!e.active,
      seat: anchorByEmp[e.id] ? anchorByEmp[e.id].seat : null,
      group: anchorByEmp[e.id] ? anchorByEmp[e.id].group : null,
    })),
    codeTable,
    shifts: shifts.results.map((s) => ({ ...s, swappable: !!s.swappable })),
    requests: requests.results,
  });
}

// GET /api/refresh — a lightweight version of bootstrap for the recurring
// background poll. Employees, the code table, and seat assignments almost
// never change, so re-reading all three of them on every single poll (as
// the full bootstrap does) was pure waste — this endpoint returns only the
// two tables that actually change on a normal day: shifts and requests.
export async function handleRefresh(env) {
  const db = env.DB;

  const [shifts, requests] = await Promise.all([
    db
      .prepare(
        `SELECT date, dow, emp_id as empId, emp_name as empName, period, code, label, swappable
         FROM shifts
         WHERE date >= date('now', '-${SHIFT_WINDOW_DAYS} days')
         ORDER BY date, emp_id`
      )
      .all(),
    db
      .prepare(
        `SELECT id, created_at as createdAt, requester_id as requesterId, requester_name as requesterName,
                target_id as targetId, target_name as targetName,
                my_date as myDate, my_dow as myDow, my_code as myCode, my_period as myPeriod,
                target_date as targetDate, target_dow as targetDow, target_code as targetCode, target_period as targetPeriod,
                status, memo, processed_at as processedAt
         FROM swap_requests
         WHERE created_at >= datetime('now', '-${SHIFT_WINDOW_DAYS} days')
         ORDER BY created_at DESC`
      )
      .all(),
  ]);

  return Response.json({
    shifts: shifts.results.map((s) => ({ ...s, swappable: !!s.swappable })),
    requests: requests.results,
  });
}

// GET /api/refresh-check — the cheap half of the polling loop. Reads a
// single row from app_state (a tiny table bumped by every mutation that
// touches shifts or swap_requests) and returns just that timestamp. The
// client compares it to what it already has: unchanged means skip the
// expensive fetch entirely, which is what most 60-second polls will do on
// an ordinary day. Only a genuine change triggers the real /api/refresh call.
export async function handleRefreshCheck(env) {
  const db = env.DB;
  const row = await db.prepare("SELECT last_changed_at FROM app_state WHERE id = 1").first();
  return Response.json({ lastChangedAt: row ? row.last_changed_at : null });
}
