function uid() {
  return crypto.randomUUID();
}

function formatDate(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
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

// A night shift immediately followed by a day shift the next day (or a day
// shift right after a night shift the day before) leaves no rest between
// them. Checks whether `empId` would end up in that situation after gaining
// a shift with the given date/period.
async function findRestConflict(db, empId, empName, date, period) {
  if (period === "야간") {
    const nextDate = dateAdd(date, 1);
    const clash = await db
      .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ? AND period = '주간'")
      .bind(nextDate, empId)
      .first();
    if (clash) return `${empName}님이 ${formatDate(nextDate)}에 주간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요. 교환할 수 없어요.`;
  }
  if (period === "주간") {
    const prevDate = dateAdd(date, -1);
    const clash = await db
      .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ? AND period = '야간'")
      .bind(prevDate, empId)
      .first();
    if (clash) return `${empName}님이 ${formatDate(prevDate)}에 야간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요. 교환할 수 없어요.`;
  }
  return null;
}

export async function handleListRequests(env) {
  const db = env.DB;
  const rows = await db
    .prepare(
      `SELECT id, created_at as createdAt, requester_id as requesterId, requester_name as requesterName,
              target_id as targetId, target_name as targetName,
              my_date as myDate, my_dow as myDow, my_code as myCode, my_period as myPeriod,
              target_date as targetDate, target_dow as targetDow, target_code as targetCode, target_period as targetPeriod,
              status, memo, processed_at as processedAt
       FROM swap_requests ORDER BY created_at DESC`
    )
    .all();
  return Response.json(rows.results);
}

export async function handleCreateRequest(request, env) {
  const db = env.DB;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 형식이에요." }, { status: 400 });
  }

  const {
    requesterId, requesterName,
    targetId, targetName,
    myDate, myDow, myCode, myPeriod,
    targetDate, targetDow, targetCode, targetPeriod,
    memo,
  } = body || {};

  if (!requesterId || !targetId || !myDate || !targetDate) {
    return Response.json({ error: "필수 항목이 빠졌어요." }, { status: 400 });
  }
  if (!myCode && !targetCode) {
    return Response.json({ error: "두 사람 다 비번이면 교환할 근무가 없어요." }, { status: 400 });
  }
  if (String(requesterId) === String(targetId)) {
    return Response.json({ error: "자기 자신과는 교환할 수 없어요." }, { status: 400 });
  }

  const myShift = await db
    .prepare("SELECT code, period FROM shifts WHERE date = ? AND emp_id = ?")
    .bind(myDate, requesterId)
    .first();
  // myCode is omitted when the requester is offering their own day off
  // (working someone else's shift on a day they'd otherwise be off).
  if (myCode) {
    if (!myShift || myShift.code !== myCode) {
      return Response.json({ error: "근무 정보가 변경되었어요. 새로고침 후 다시 시도해주세요." }, { status: 409 });
    }
  } else if (myShift) {
    return Response.json({ error: "그 사이 나에게 이미 근무가 생겼어요. 새로고침 후 다시 시도해주세요." }, { status: 409 });
  }

  const targetShift = await db
    .prepare("SELECT code, period FROM shifts WHERE date = ? AND emp_id = ?")
    .bind(targetDate, targetId)
    .first();
  // targetCode is omitted when the requester is asking for the target's
  // day off (target has no shift that date) — confirm that's still true.
  if (targetCode) {
    if (!targetShift || targetShift.code !== targetCode) {
      return Response.json({ error: "근무 정보가 변경되었어요. 새로고침 후 다시 시도해주세요." }, { status: 409 });
    }
  } else if (targetShift) {
    return Response.json({ error: "상대방에게 이미 그 날짜에 근무가 생겼어요. 새로고침 후 다시 시도해주세요." }, { status: 409 });
  }

  // A swap would double-book either side if they already independently
  // have a shift on the date they'd be taking over.
  if (myDate !== targetDate) {
    if (myCode) {
      const targetOnMyDate = await db
        .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(myDate, targetId)
        .first();
      if (targetOnMyDate) {
        return Response.json(
          { error: `상대방이 ${formatDate(myDate)}에 이미 다른 근무가 있어서 교환할 수 없어요.` },
          { status: 409 }
        );
      }
    }
    if (targetCode) {
      const requesterOnTargetDate = await db
        .prepare("SELECT 1 FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(targetDate, requesterId)
        .first();
      if (requesterOnTargetDate) {
        return Response.json(
          { error: `내가 ${formatDate(targetDate)}에 이미 다른 근무가 있어서 교환할 수 없어요.` },
          { status: 409 }
        );
      }
    }
  }

  // A night shift right next to a day shift on the adjacent date leaves no
  // rest — check both people for whichever new shift they'd be gaining.
  if (myCode) {
    const msg = await findRestConflict(db, targetId, targetName, myDate, myPeriod);
    if (msg) return Response.json({ error: msg }, { status: 409 });
  }
  if (targetCode) {
    const msg = await findRestConflict(db, requesterId, requesterName, targetDate, targetPeriod);
    if (msg) return Response.json({ error: msg }, { status: 409 });
  }

  const id = uid();
  const createdAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO swap_requests
       (id, created_at, requester_id, requester_name, target_id, target_name,
        my_date, my_dow, my_code, my_period, target_date, target_dow, target_code, target_period,
        status, memo, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '대기', ?, NULL)`
    )
    .bind(
      id, createdAt, requesterId, requesterName, targetId, targetName,
      myDate, myDow, myCode ?? null, myPeriod ?? null, targetDate, targetDow, targetCode ?? null, targetPeriod ?? null,
      memo || ""
    )
    .run();

  return Response.json({ id, createdAt, status: "대기" });
}
