import { planReciprocalSwap, computeReciprocalFinalStates } from "./swapPlan.js";
import { checkRestForFinalStates } from "./restCheck.js";

function dateAdd(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Given a swap that's currently blocked, searches every other active
// employee for a way to move the ONE blocking shift (whichever adjacent-day
// shift is causing the conflict) to them instead — a same-date exchange
// between just the blocked person and the candidate — such that:
//   1. The candidate's own adjacent days stay valid after taking it on.
//   2. The blocked person's own adjacent days stay valid after giving it up.
//   3. The ORIGINAL desired swap then passes rest-checks too.
// Returns { alreadyPossible: true } if no bridge was even needed, or
// { alreadyPossible: false, bridges: [...] } listing every viable 2-step
// path found (each naming the bridge candidate, the date, and what they'd
// trade). Never touches the DB — this only searches and reports.
export async function findSwapBridges(db, params) {
  const { requesterId, requesterName, myDate, myCode, myPeriod, targetId, targetName, targetDate, targetCode, targetPeriod } = params;

  const direct = await planReciprocalSwap(db, params);
  if (direct.ok) {
    return { alreadyPossible: true };
  }

  // Candidate blocking dates: the day right before/after each date in this
  // swap, for whichever of the two people would actually occupy it.
  const candidateDates = new Set(
    [dateAdd(myDate, -1), dateAdd(myDate, 1), dateAdd(targetDate, -1), dateAdd(targetDate, 1)]
      .filter((d) => d !== myDate && d !== targetDate)
  );

  const activeRows = await db.prepare("SELECT id, name FROM employees WHERE active = 1").all();
  const activeEmployees = activeRows.results.filter((e) => e.id !== requesterId && e.id !== targetId);

  const bridges = [];

  for (const blockDate of candidateDates) {
    for (const person of [
      { id: requesterId, name: requesterName },
      { id: targetId, name: targetName },
    ]) {
      const blockingShift = await db
        .prepare("SELECT code, period FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(blockDate, person.id)
        .first();
      if (!blockingShift) continue; // nothing of theirs to move away on this date

      for (const cand of activeEmployees) {
        const candShift = await db
          .prepare("SELECT code, period FROM shifts WHERE date = ? AND emp_id = ?")
          .bind(blockDate, cand.id)
          .first();

        // Simulate: person's blockDate shift <-> candidate's blockDate shift (or nothing).
        const personFinal = { [blockDate]: candShift ? { code: candShift.code, period: candShift.period } : null };
        const candFinal = { [blockDate]: { code: blockingShift.code, period: blockingShift.period } };

        const personMsg = await checkRestForFinalStates(db, person.id, person.name, personFinal);
        if (personMsg) continue;
        const candMsg = await checkRestForFinalStates(db, cand.id, cand.name, candFinal);
        if (candMsg) continue;

        // Now re-check the ORIGINAL swap, but with this bridge's date
        // overridden to its post-bridge value for whichever side owns it.
        const { requesterFinal, targetFinal } = await computeReciprocalFinalStates(db, params);
        if (person.id === requesterId) requesterFinal[blockDate] = personFinal[blockDate];
        if (person.id === targetId) targetFinal[blockDate] = personFinal[blockDate];

        const msg1 = await checkRestForFinalStates(db, requesterId, requesterName, requesterFinal);
        if (msg1) continue;
        const msg2 = await checkRestForFinalStates(db, targetId, targetName, targetFinal);
        if (msg2) continue;

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
