export async function handleBootstrap(env) {
  const db = env.DB;

  const [employees, codeRows, shifts, requests] = await Promise.all([
    db.prepare("SELECT id, name, active FROM employees ORDER BY id").all(),
    db.prepare("SELECT code, day_label, night_label FROM code_table").all(),
    db
      .prepare(
        "SELECT date, dow, emp_id as empId, emp_name as empName, period, code, label, swappable FROM shifts ORDER BY date, emp_id"
      )
      .all(),
    db
      .prepare(
        `SELECT id, created_at as createdAt, requester_id as requesterId, requester_name as requesterName,
                target_id as targetId, target_name as targetName,
                my_date as myDate, my_dow as myDow, my_code as myCode, my_period as myPeriod,
                target_date as targetDate, target_dow as targetDow, target_code as targetCode, target_period as targetPeriod,
                status, memo, processed_at as processedAt
         FROM swap_requests ORDER BY created_at DESC`
      )
      .all(),
  ]);

  const codeTable = {};
  for (const r of codeRows.results) {
    codeTable[r.code] = { dayLabel: r.day_label, nightLabel: r.night_label };
  }

  return Response.json({
    employees: employees.results.map((e) => ({ ...e, active: !!e.active })),
    codeTable,
    shifts: shifts.results.map((s) => ({ ...s, swappable: !!s.swappable })),
    requests: requests.results,
  });
}
