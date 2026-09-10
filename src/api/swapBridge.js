import { restHoursBetweenAdjacentDays, MIN_REST_HOURS, formatDateShared, dateAddShared } from "./restCheck.js";

// In-memory rest check — identical rules to checkRestForFinalStates in
// restCheck.js, but reads from a preloaded shiftMap (shiftMap[date][empId])
// instead of querying D1. Used only by the bridge search below, which needs
// to run this check many times per request — hitting the DB for each one
// was the actual cause of the runaway D1 usage (thousands of individual
// queries per click).
function checkRestInMemory(shiftMap, empId, empName, finalStates) {
  for (const date of Object.keys(finalStates)) {
    const cur = finalStates[date];
    if (!cur || !cur.code || cur.code === "비번") continue;

    const nextDate = dateAddShared(date, 1);
    const next = Object.prototype.hasOwnProperty.call(finalStates, nextDate)
      ? finalStates[nextDate]
      : shiftMap[nextDate]?.[empId] || null;
    if (next) {
      if (cur.period === "야간" && next.period === "주간") {
        return `${empName}님이 ${formatDateShared(nextDate)}에 주간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요.`;
      }
      const rest = restHoursBetweenAdjacentDays(cur.code, cur.period, next.code, next.period);
      if (rest !== null && rest < MIN_REST_HOURS) {
        return `${empName}님이 ${formatDateShared(nextDate)}에 근무가 있어서, 퇴근 후 휴식이 ${rest}시간뿐이에요.`;
      }
    }

    const prevDate = dateAddShared(date, -1);
    const prev = Object.prototype.hasOwnProperty.call(finalStates, prevDate)
      ? finalStates[prevDate]
      : shiftMap[prevDate]?.[empId] || null;
    if (prev) {
      if (prev.period === "야간" && cur.period === "주간") {
        return `${empName}님이 ${formatDateShared(prevDate)}에 야간 근무가 있어서, 밤을 새고 바로 이어지는 근무가 돼요.`;
      }
      const rest = restHoursBetweenAdjacentDays(prev.code, prev.period, cur.code, cur.period);
      if (rest !== null && rest < MIN_REST_HOURS) {
        return `${empName}님이 ${formatDateShared(prevDate)} 근무 이후 휴식이 ${rest}시간뿐이에요.`;
      }
    }
  }
  return null;
}

// In-memory equivalent of computeReciprocalFinalStates.
function computeReciprocalInMemory(shiftMap, { requesterId, myDate, myCode, myPeriod, targetId, targetDate, targetCode, targetPeriod }) {
  let rowC = null;
  let rowD = null;
  if (myDate !== targetDate) {
    if (targetCode) rowC = shiftMap[targetDate]?.[requesterId] || null;
    if (myCode) rowD = shiftMap[myDate]?.[targetId] || null;
  }
  const requesterFinal = {
    [myDate]: rowD ? { code: rowD.code, period: rowD.period } : null,
    [targetDate]: targetCode ? { code: targetCode, period: targetPeriod } : null,
  };
  const targetFinal = {
    [myDate]: myCode ? { code: myCode, period: myPeriod } : null,
    [targetDate]: rowC ? { code: rowC.code, period: rowC.period } : null,
  };
  return { rowC, rowD, requesterFinal, targetFinal };
}

// Given a swap that's currently blocked, searches every other active
// employee for a way to move the ONE blocking shift (whichever adjacent-day
// shift is causing the conflict) to them instead — a same-date exchange
// between just the blocked person and the candidate — such that:
//   1. The candidate's own adjacent days stay valid after taking it on.
//   2. The blocked person's own adjacent days stay valid after giving it up.
//   3. The ORIGINAL desired swap then passes rest-checks too.
//
// Loads every shift it could possibly need in ONE query up front, then does
// the entire search in memory — no per-candidate DB round trips.
export async function findSwapBridges(db, params) {
  const { requesterId, requesterName, myDate, myCode, myPeriod, targetId, targetName, targetDate, targetCode, targetPeriod } = params;

  const candidateDates = [...new Set(
    [dateAddShared(myDate, -1), dateAddShared(myDate, 1), dateAddShared(targetDate, -1), dateAddShared(targetDate, 1)]
      .filter((d) => d !== myDate && d !== targetDate)
  )];

  const allDatesNeeded = new Set([myDate, targetDate, ...candidateDates]);
  for (const d of candidateDates) {
    allDatesNeeded.add(dateAddShared(d, -1));
    allDatesNeeded.add(dateAddShared(d, 1));
  }
  const dateList = [...allDatesNeeded];

  const activeRows = await db.prepare("SELECT id, name FROM employees WHERE active = 1").all();
  const activeEmployees = activeRows.results.filter((e) => e.id !== requesterId && e.id !== targetId);

  // One bulk read covering every date this search could ever need, for
  // every active employee — instead of one query per (date, person) pair.
  const placeholders = dateList.map(() => "?").join(",");
  const shiftRows = await db
    .prepare(`SELECT date, emp_id as empId, code, period FROM shifts WHERE date IN (${placeholders})`)
    .bind(...dateList)
    .all();

  const shiftMap = {};
  for (const row of shiftRows.results) {
    if (!shiftMap[row.date]) shiftMap[row.date] = {};
    shiftMap[row.date][row.empId] = { code: row.code, period: row.period };
  }

  // Direct check first — maybe no bridge is even needed.
  const direct = computeReciprocalInMemory(shiftMap, params);
  const directMsg1 = checkRestInMemory(shiftMap, requesterId, requesterName, direct.requesterFinal);
  const directMsg2 = directMsg1 ? null : checkRestInMemory(shiftMap, targetId, targetName, direct.targetFinal);
  if (!directMsg1 && !directMsg2) {
    return { alreadyPossible: true };
  }

  const bridges = [];

  for (const blockDate of candidateDates) {
    for (const person of [
      { id: requesterId, name: requesterName },
      { id: targetId, name: targetName },
    ]) {
      const blockingShift = shiftMap[blockDate]?.[person.id] || null;
      if (!blockingShift) continue; // nothing of theirs to move away on this date

      for (const cand of activeEmployees) {
        const candShift = shiftMap[blockDate]?.[cand.id] || null;

        const personFinal = { [blockDate]: candShift ? { code: candShift.code, period: candShift.period } : null };
        const candFinal = { [blockDate]: { code: blockingShift.code, period: blockingShift.period } };

        if (checkRestInMemory(shiftMap, person.id, person.name, personFinal)) continue;
        if (checkRestInMemory(shiftMap, cand.id, cand.name, candFinal)) continue;

        const { requesterFinal, targetFinal } = computeReciprocalInMemory(shiftMap, params);
        if (person.id === requesterId) requesterFinal[blockDate] = personFinal[blockDate];
        if (person.id === targetId) targetFinal[blockDate] = personFinal[blockDate];

        if (checkRestInMemory(shiftMap, requesterId, requesterName, requesterFinal)) continue;
        if (checkRestInMemory(shiftMap, targetId, targetName, targetFinal)) continue;

        bridges.push({
          bridgeEmployeeId: cand.id,
          bridgeEmployeeName: cand.name,
          blockDate,
          movedFrom: { id: person.id, name: person.name },
          movedShift: { code: blockingShift.code, period: blockingShift.period },
          bridgeGivesBack: candShift ? { code: candShift.code, period: candShift.period } : null,
        });
      }
    }
  }

  return { alreadyPossible: false, bridges };
}

// POST /api/admin/find-swap-bridge
export async function handleFindSwapBridge(request, env) {
  const db = env.DB;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청 형식이에요." }, { status: 400 });
  }

  if (!env.ADMIN_PIN) {
    return Response.json({ error: "관리자 기능이 아직 설정되지 않았어요 (ADMIN_PIN 미설정)." }, { status: 500 });
  }
  if (!body.pin || body.pin !== env.ADMIN_PIN) {
    return Response.json({ error: "비밀번호가 올바르지 않아요." }, { status: 403 });
  }

  const { requesterId, requesterName, myDate, myCode, myPeriod, targetId, targetName, targetDate, targetCode, targetPeriod } = body;
  if (!requesterId || !requesterName || !myDate || !targetId || !targetName || !targetDate) {
    return Response.json({ error: "필수 항목이 빠졌어요." }, { status: 400 });
  }

  const result = await findSwapBridges(db, {
    requesterId, requesterName, myDate, myCode: myCode || null, myPeriod: myPeriod || null,
    targetId, targetName, targetDate, targetCode: targetCode || null, targetPeriod: targetPeriod || null,
  });

  return Response.json(result);
}
