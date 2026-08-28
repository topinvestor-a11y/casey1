import { checkTwelveHourRest } from "./restCheck.js";

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
// code = null clears the shift row entirely. code = '비번' marks an
// explicit non-working status (with substitute handoff support) — distinct
// from a cleared row, which also displays as "비번" but has no such tracking.
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

  // Leaving on 비번 usually means someone else has to cover the duty this
  // person would have had — capture it now, before it's overwritten, so it
  // can be handed to a substitute below.
  let vacatedShift = null;
  if (code === "비번") {
    vacatedShift = await db
      .prepare("SELECT code, period FROM shifts WHERE date = ? AND emp_id = ?")
      .bind(date, empId)
      .first();
  }

  // Check the substitute BEFORE touching anything: if they already have a
  // different shift that day, handing them the vacated duty would just
  // silently create a new coverage gap in their place. Block instead.
  let sub = null;
  if (code === "비번" && body.substituteEmpId && vacatedShift) {
    sub = await db.prepare("SELECT id, name FROM employees WHERE id = ?").bind(body.substituteEmpId).first();
    if (!sub) {
      return Response.json({ error: "대체 근무자를 찾을 수 없어요." }, { status: 404 });
    }
    const subExisting = await db
      .prepare("SELECT code, label FROM shifts WHERE date = ? AND emp_id = ?")
      .bind(date, sub.id)
      .first();
    if (subExisting) {
      return Response.json(
        { error: `${sub.name}님은 ${formatDateAdmin(date)}에 이미 다른 근무(${subExisting.label})가 있어서 대체 근무자로 지정할 수 없어요.` },
        { status: 409 }
      );
    }
  }

  const result = await assignShift(db, empId, emp.name, date, code, period, "관리자 직접 수정");
  if (result.error) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  let substituteResult = null;
  if (sub) {
    const subResult = await assignShift(db, sub.id, sub.name, date, vacatedShift.code, vacatedShift.period, "비번자 대체 근무 배정");
    if (subResult.error) {
      return Response.json({ error: `비번 처리는 됐지만, 대체 근무자 배정에 실패했어요: ${subResult.error}` }, { status: subResult.status });
    }
    substituteResult = { empId: sub.id, name: sub.name, code: vacatedShift.code, period: vacatedShift.period, label: subResult.label };
  }

  return Response.json({ ...result, substitute: substituteResult });
}

// Core upsert: applies the single-slot-per-code rule and the adjacent-day
// rest check, then writes the row. Every change is written to
// shift_edit_log (before/after) so admins can review what happened later.
async function assignShift(db, empId, empName, date, code, period, reason) {
  const dow = dowForDateAdmin(date);
  const now = new Date().toISOString();

  const before = await db
    .prepare("SELECT code, period, label FROM shifts WHERE date = ? AND emp_id = ?")
    .bind(date, empId)
    .first();

  async function log(newCode, newPeriod, newLabel, logReason) {
    await db
      .prepare(
        `INSERT INTO shift_edit_log
         (created_at, emp_id, emp_name, date, dow, old_code, old_period, old_label, new_code, new_period, new_label, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        now, empId, empName, date, dow,
        before?.code ?? null, before?.period ?? null, before?.label ?? null,
        newCode, newPeriod, newLabel, logReason
      )
      .run();
  }

  if (!code) {
    await db.prepare("DELETE FROM shifts WHERE date = ? AND emp_id = ?").bind(date, empId).run();
    await log(null, null, null, reason);
    return { empId, name: empName, date, dow, code: null };
  }

  let label;
  let finalPeriod = period || "주간";
  let swappable = 1;

  if (code === "비번") {
    label = "비번";
    finalPeriod = "주간";
    swappable = 0;
  } else {
    const codeRow = await db.prepare("SELECT day_label, night_label FROM code_table WHERE code = ?").bind(code).first();
    if (!codeRow) {
      return { error: "알 수 없는 근무 코드예요.", status: 400 };
    }
    label = finalPeriod === "야간" ? codeRow.night_label || codeRow.day_label : codeRow.day_label;
  }

  // A real duty code is a single slot — only one person can hold a given
  // (date, period, code) at a time. Vacation ("비번") is a personal status,
  // not a slot, so it's exempt.
  let freed = [];
  if (code !== "비번") {
    const holders = await db
      .prepare("SELECT emp_id, emp_name, code, period, label FROM shifts WHERE date = ? AND period = ? AND code = ? AND emp_id != ?")
      .bind(date, finalPeriod, code, empId)
      .all();
    if (holders.results.length > 0) {
      await db.batch(
        holders.results.map((h) =>
          db.prepare("DELETE FROM shifts WHERE date = ? AND emp_id = ?").bind(date, h.emp_id)
        )
      );
      await db.batch(
        holders.results.map((h) =>
          db
            .prepare(
              `INSERT INTO shift_edit_log
               (created_at, emp_id, emp_name, date, dow, old_code, old_period, old_label, new_code, new_period, new_label, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
            )
            .bind(now, h.emp_id, h.emp_name, date, dow, h.code, h.period, h.label, `${empName}님이 같은 근무를 배정받아 비번 처리됨`)
        )
      );
      freed = holders.results.map((h) => h.emp_name);
    }

    // Real clock-hours check: gaining this shift must still leave at least
    // 12 hours of rest against whatever's on the adjacent day.
    const restMsg = await checkTwelveHourRest(db, empId, empName, date, code, finalPeriod);
    if (restMsg) {
      return { error: restMsg.replace("교환할 수 없어요.", "다른 코드를 선택해주세요."), status: 409 };
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
    .bind(date, dow, empId, empName, finalPeriod, code, label, swappable)
    .run();

  await log(code, finalPeriod, label, reason);

  return { empId, name: empName, date, dow, period: finalPeriod, code, label, freed };
}

// GET /api/admin/shift-log?pin=...&limit=100
export async function handleGetShiftLog(request, env) {
  const db = env.DB;
  const url = new URL(request.url);
  const pin = url.searchParams.get("pin");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 300);

  if (!env.ADMIN_PIN) {
    return Response.json({ error: "관리자 기능이 아직 설정되지 않았어요 (ADMIN_PIN 미설정)." }, { status: 500 });
  }
  if (!pin || pin !== env.ADMIN_PIN) {
    return Response.json({ error: "비밀번호가 올바르지 않아요." }, { status: 403 });
  }

  const rows = await db
    .prepare(
      `SELECT id, created_at as createdAt, emp_id as empId, emp_name as empName, date, dow,
              old_code as oldCode, old_period as oldPeriod, old_label as oldLabel,
              new_code as newCode, new_period as newPeriod, new_label as newLabel, reason
       FROM shift_edit_log ORDER BY created_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();

  return Response.json(rows.results);
}
