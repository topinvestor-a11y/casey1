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

// POST /api/admin/set-shift
// body: { pin, empId, date, code, period }
// code = null clears the shift (becomes 비번). code = '휴가' marks leave.
// Otherwise code must be a real code_table entry. Upserts the shifts row —
// used for manual corrections (vacation, extended leave, one-off edits).
function dowForDateAdmin(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const names = ["일", "월", "화", "수", "목", "금", "토"];
  return names[dt.getUTCDay()];
}

function dateAddAdmin(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function formatDateAdmin(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

export async function handleSetShift(request, env) {
  const db = env.DB;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 형식이에요." }, { status: 400 });
  }

  const { pin, empId, date, code, period } = body || {};

  if (!env.ADMIN_PIN) {
    return Response.json({ error: "관리자 기능이 아직 설정되지 않았어요 (ADMIN_PIN 미설정)." }, { status: 500 });
  }
  if (!pin || pin !== env.ADMIN_PIN) {
    return Response.json({ error: "비밀번호가 올바르지 않아요." }, { status: 403 });
  }
  if (!empId || !date) {
    return Response.json({ error: "필수 항목이 빠졌어요." }, { status: 400 });
  }

  const emp = await db.prepare("SELECT id, name FROM employees WHERE id = ?").bind(empId).first();
  if (!emp) {
    return Response.json({ error: "해당 직원을 찾을 수 없어요." }, { status: 404 });
  }

  const dow = dowForDateAdmin(date);

  if (!code) {
    await db.prepare("DELETE FROM shifts WHERE date = ? AND emp_id = ?").bind(date, empId).run();
    return Response.json({ empId: emp.id, name: emp.name, date, dow, code: null });
  }

  let label;
  let finalPeriod = period || "주간";
  let swappable = 1;

  if (code === "휴가") {
    label = "휴가";
    finalPeriod = "주간";
    swappable = 0;
  } else {
    const codeRow = await db.prepare("SELECT day_label, night_label FROM code_table WHERE code = ?").bind(code).first();
    if (!codeRow) {
      return Response.json({ error: "알 수 없는 근무 코드예요." }, { status: 400 });
    }
    label = finalPeriod === "야간" ? codeRow.night_label || codeRow.day_label : codeRow.day_label;
  }

  // A real duty code is a single slot — only one person can hold a given
  // (date, period, code) at a time. Vacation ("휴가") is a personal status,
  // not a slot, so it's exempt.
  let freed = [];
  if (code !== "휴가") {
    const holders = await db
      .prepare("SELECT emp_id, emp_name FROM shifts WHERE date = ? AND period = ? AND code = ? AND emp_id != ?")
      .bind(date, finalPeriod, code, empId)
      .all();
    if (holders.results.length > 0) {
      await db.batch(
        holders.results.map((h) =>
          db.prepare("DELETE FROM shifts WHERE date = ? AND emp_id = ?").bind(date, h.emp_id)
        )
      );
      freed = holders.results.map((h) => h.emp_name);
    }

    // Same night-then-day / day-after-night rest check used for swaps.
    if (finalPeriod === "야간") {
      const nextDate = dateAddAdmin(date, 1);
      const clash = await db
        .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ? AND period = '주간'")
        .bind(nextDate, empId)
        .first();
      if (clash) {
        return Response.json(
          { error: `${emp.name}님이 ${formatDateAdmin(nextDate)}에 주간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요. 다른 코드를 선택해주세요.` },
          { status: 409 }
        );
      }
    }
    if (finalPeriod === "주간") {
      const prevDate = dateAddAdmin(date, -1);
      const clash = await db
        .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ? AND period = '야간'")
        .bind(prevDate, empId)
        .first();
      if (clash) {
        return Response.json(
          { error: `${emp.name}님이 ${formatDateAdmin(prevDate)}에 야간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요. 다른 코드를 선택해주세요.` },
          { status: 409 }
        );
      }
    }
  }

  await db
    .prepare(
      `INSERT INTO shifts (date, dow, emp_id, emp_name, period, code, label, swappable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, emp_id) DO UPDATE SET
         dow = excluded.dow, period = excluded.period, code = excluded.code,
         label = excluded.label, swappable = excluded.swappable`
    )
    .bind(date, dow, empId, emp.name, finalPeriod, code, label, swappable)
    .run();

  return Response.json({ empId: emp.id, name: emp.name, date, dow, period: finalPeriod, code, label, freed });
}
