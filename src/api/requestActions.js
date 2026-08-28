import { checkRestForFinalStates } from "./restCheck.js";

export async function handleRespond(id, request, env) {
  const db = env.DB;

  function formatDate(dateStr) {
    const [, m, d] = dateStr.split("-");
    return `${Number(m)}월 ${Number(d)}일`;
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 형식이에요." }, { status: 400 });
  }
  const accept = !!body.accept;

  // Accepting actually changes the real schedule, so it's admin-gated —
  // same PIN as "다음 주 자동 생성". Rejecting doesn't touch shifts, so
  // it's left open.
  if (accept) {
    if (!env.ADMIN_PIN) {
      return Response.json({ error: "관리자 기능이 아직 설정되지 않았어요 (ADMIN_PIN 미설정)." }, { status: 500 });
    }
    if (!body.pin || body.pin !== env.ADMIN_PIN) {
      return Response.json({ error: "비밀번호가 올바르지 않아요." }, { status: 403 });
    }
  }

  const req = await db.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(id).first();
  if (!req) return Response.json({ error: "요청을 찾을 수 없어요." }, { status: 404 });
  if (req.status !== "대기") {
    return Response.json({ error: "이미 처리된 요청이에요." }, { status: 409 });
  }

  const processedAt = new Date().toISOString();

  if (accept) {
    let a = null;
    if (req.my_code) {
      a = await db
        .prepare("SELECT id FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(req.my_date, req.requester_id)
        .first();
      if (!a) {
        return Response.json({ error: "근무 기록을 찾을 수 없어 처리하지 못했어요." }, { status: 409 });
      }
    } else {
      // Day-off on the requester's side: confirm they still genuinely have no shift there.
      const stillOff = await db
        .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(req.my_date, req.requester_id)
        .first();
      if (stillOff) {
        return Response.json(
          { error: "그 사이 나에게 다른 근무가 생겨서 처리하지 못했어요." },
          { status: 409 }
        );
      }
    }

    let b = null;
    if (req.target_code) {
      b = await db
        .prepare("SELECT id FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(req.target_date, req.target_id)
        .first();
      if (!b) {
        return Response.json({ error: "근무 기록을 찾을 수 없어 처리하지 못했어요." }, { status: 409 });
      }
    } else {
      // Day-off swap: confirm the target still genuinely has no shift there.
      const stillOff = await db
        .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(req.target_date, req.target_id)
        .first();
      if (stillOff) {
        return Response.json(
          { error: "그 사이 상대방에게 다른 근무가 생겨서 처리하지 못했어요." },
          { status: 409 }
        );
      }
    }

    if (!a && !b) {
      return Response.json({ error: "교환할 근무가 없어요." }, { status: 409 });
    }

    // If either side ALREADY has their own separate shift on the OTHER
    // person's date, that leftover shift trades hands too (between these
    // same two people only) so the exchange completes without leaving
    // anyone double-booked or unstaffed.
    let rowC = null;
    let rowD = null;
    if (req.my_date !== req.target_date) {
      if (req.target_code) {
        rowC = await db
          .prepare("SELECT id, code, period FROM shifts WHERE date = ? AND emp_id = ?")
          .bind(req.target_date, req.requester_id)
          .first();
      }
      if (req.my_code) {
        rowD = await db
          .prepare("SELECT id, code, period FROM shifts WHERE date = ? AND emp_id = ?")
          .bind(req.my_date, req.target_id)
          .first();
      }
    }

    // Rest-hours validated using the FINAL combined state for both dates
    // together (re-checked here in case anything shifted since the
    // request was created).
    const requesterFinal = {
      [req.my_date]: rowD ? { code: rowD.code, period: rowD.period } : null,
      [req.target_date]: req.target_code ? { code: req.target_code, period: req.target_period } : null,
    };
    const targetFinal = {
      [req.my_date]: req.my_code ? { code: req.my_code, period: req.my_period } : null,
      [req.target_date]: rowC ? { code: rowC.code, period: rowC.period } : null,
    };
    const msg1 = await checkRestForFinalStates(db, req.requester_id, req.requester_name, requesterFinal);
    if (msg1) return Response.json({ error: msg1 }, { status: 409 });
    const msg2 = await checkRestForFinalStates(db, req.target_id, req.target_name, targetFinal);
    if (msg2) return Response.json({ error: msg2 }, { status: 409 });

    const updates = [];

    if (req.my_date === req.target_date) {
      // Same-date swap: only rows a/b are involved.
      if (a && b) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = -1 WHERE id = ?").bind(a.id));
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.requester_id, req.requester_name, b.id));
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, a.id));
      } else if (a && !b) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, a.id));
      } else {
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.requester_id, req.requester_name, b.id));
      }
    } else {
      // myDate side: row a (requester -> target) and, if it exists, row D
      // (target's own shift there, which reciprocally moves to requester).
      if (a && rowD) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = -1 WHERE id = ?").bind(a.id));
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.requester_id, req.requester_name, rowD.id));
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, a.id));
      } else if (a && !rowD) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, a.id));
      } else if (!a && rowD) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.requester_id, req.requester_name, rowD.id));
      }

      // targetDate side: row b (target -> requester) and, if it exists,
      // row C (requester's own shift there, reciprocally moving to target).
      if (b && rowC) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = -1 WHERE id = ?").bind(b.id));
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, rowC.id));
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.requester_id, req.requester_name, b.id));
      } else if (b && !rowC) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.requester_id, req.requester_name, b.id));
      } else if (!b && rowC) {
        updates.push(db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, rowC.id));
      }
    }

    updates.push(db.prepare("UPDATE swap_requests SET status = '완료', processed_at = ? WHERE id = ?").bind(processedAt, id));
    await db.batch(updates);
  } else {
    await db.prepare("UPDATE swap_requests SET status = '거절', processed_at = ? WHERE id = ?").bind(processedAt, id).run();
  }

  return Response.json({ id, status: accept ? "완료" : "거절", processedAt });
}

export async function handleCancel(id, env) {
  const db = env.DB;

  const req = await db.prepare("SELECT status FROM swap_requests WHERE id = ?").bind(id).first();
  if (!req) return Response.json({ error: "요청을 찾을 수 없어요." }, { status: 404 });
  if (req.status !== "대기") {
    return Response.json({ error: "이미 처리된 요청이에요." }, { status: 409 });
  }

  const processedAt = new Date().toISOString();
  await db.prepare("UPDATE swap_requests SET status = '취소', processed_at = ? WHERE id = ?").bind(processedAt, id).run();

  return Response.json({ id, status: "취소", processedAt });
}
