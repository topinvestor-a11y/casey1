export async function handleRespond(id, request, env) {
  const db = env.DB;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 형식이에요." }, { status: 400 });
  }
  const accept = !!body.accept;

  const req = await db.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(id).first();
  if (!req) return Response.json({ error: "요청을 찾을 수 없어요." }, { status: 404 });
  if (req.status !== "대기") {
    return Response.json({ error: "이미 처리된 요청이에요." }, { status: 409 });
  }

  const processedAt = new Date().toISOString();

  if (accept) {
    const a = await db
      .prepare("SELECT id FROM shifts WHERE date = ? AND emp_id = ?")
      .bind(req.my_date, req.requester_id)
      .first();
    if (!a) {
      return Response.json({ error: "근무 기록을 찾을 수 없어 처리하지 못했어요." }, { status: 409 });
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

    if (req.my_date !== req.target_date) {
      const targetOnMyDate = await db
        .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(req.my_date, req.target_id)
        .first();
      if (targetOnMyDate) {
        return Response.json(
          { error: "상대방이 그 사이 다른 날짜에 근무가 생겨서 처리하지 못했어요." },
          { status: 409 }
        );
      }
      if (b) {
        const requesterOnTargetDate = await db
          .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ?")
          .bind(req.target_date, req.requester_id)
          .first();
        if (requesterOnTargetDate) {
          return Response.json(
            { error: "그 사이 다른 날짜에 근무가 생겨서 처리하지 못했어요." },
            { status: 409 }
          );
        }
      }
    }

    if (b) {
      // Placeholder emp_id avoids a UNIQUE(date, emp_id) collision when both
      // shifts fall on the same date. Row `a` (was the requester's) becomes
      // the target's, and row `b` (was the target's) becomes the requester's.
      await db.batch([
        db.prepare("UPDATE shifts SET emp_id = -1 WHERE id = ?").bind(a.id),
        db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.requester_id, req.requester_name, b.id),
        db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, a.id),
        db.prepare("UPDATE swap_requests SET status = '완료', processed_at = ? WHERE id = ?").bind(processedAt, id),
      ]);
    } else {
      // Day-off swap: the target simply takes over row `a`. Nothing needs
      // to be written for the requester on target_date — they're off,
      // same as the target was.
      await db.batch([
        db.prepare("UPDATE shifts SET emp_id = ?, emp_name = ? WHERE id = ?").bind(req.target_id, req.target_name, a.id),
        db.prepare("UPDATE swap_requests SET status = '완료', processed_at = ? WHERE id = ?").bind(processedAt, id),
      ]);
    }
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
