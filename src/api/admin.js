// POST /api/admin/replace-employee
// body: { pin, retiringEmpId, newEmployeeName }
//
// Retires an employee and hands their rotation seat to a brand-new
// employee (same pattern as the 양범준→강병희 handoff in the seed data).
// Past shift history keeps the old employee's name; only future
// auto-generated weeks pick up the new one.
export async function handleReplaceEmployee(request, env) {
  const db = env.DB;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 형식이에요." }, { status: 400 });
  }

  const { pin, retiringEmpId, newEmployeeName } = body || {};

  if (!env.ADMIN_PIN) {
    return Response.json({ error: "관리자 기능이 아직 설정되지 않았어요 (ADMIN_PIN 미설정)." }, { status: 500 });
  }
  if (!pin || pin !== env.ADMIN_PIN) {
    return Response.json({ error: "비밀번호가 올바르지 않아요." }, { status: 403 });
  }

  const newName = (newEmployeeName || "").trim();
  if (!retiringEmpId || !newName) {
    return Response.json({ error: "필수 항목이 빠졌어요." }, { status: 400 });
  }

  const retiring = await db.prepare("SELECT id, name, active FROM employees WHERE id = ?").bind(retiringEmpId).first();
  if (!retiring) {
    return Response.json({ error: "해당 직원을 찾을 수 없어요." }, { status: 404 });
  }
  if (!retiring.active) {
    return Response.json({ error: "이미 퇴사 처리된 직원이에요." }, { status: 409 });
  }

  const anchor = await db.prepare("SELECT seat, grp FROM anchor_week WHERE emp_id = ?").bind(retiringEmpId).first();
  if (!anchor) {
    return Response.json({ error: "이 직원은 순환 자리 정보가 없어서 자동 교체할 수 없어요." }, { status: 409 });
  }

  // Create the new employee.
  const insertResult = await db
    .prepare("INSERT INTO employees (name, active) VALUES (?, 1)")
    .bind(newName)
    .run();
  const newEmpId = insertResult.meta.last_row_id;

  // Retire the old employee and hand off the seat.
  await db.batch([
    db.prepare("UPDATE employees SET active = 0 WHERE id = ?").bind(retiringEmpId),
    db.prepare("UPDATE anchor_week SET emp_id = ? WHERE emp_id = ?").bind(newEmpId, retiringEmpId),
  ]);

  return Response.json({
    retired: { id: retiring.id, name: retiring.name },
    hired: { id: newEmpId, name: newName, seat: anchor.seat, group: anchor.grp },
  });
}
