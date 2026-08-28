import { checkRestForFinalStates } from "./restCheck.js";

// When requester and target are trading (myDate, myCode) for (targetDate,
// targetCode) and the dates differ, either side might ALREADY have their
// own separate shift on the OTHER person's date. Rather than blocking that,
// complete the loop: that leftover shift also changes hands between the
// same two people, so nobody's day goes unstaffed and no third party is
// ever touched. Rest-hours are checked using the FINAL combined state for
// both dates together (not one at a time), since both may be changing in
// this same transaction.
//
// Returns { error, status } or { ok: true, rowC, rowD } where rowC is the
// requester's existing row on targetDate (or null) and rowD is the
// target's existing row on myDate (or null) — looked up fresh from the DB.
export async function planReciprocalSwap(db, {
  requesterId, requesterName, myDate, myCode, myPeriod,
  targetId, targetName, targetDate, targetCode, targetPeriod,
}) {
  let rowC = null;
  let rowD = null;

  if (myDate !== targetDate) {
    if (targetCode) {
      rowC = await db
        .prepare("SELECT id, code, period FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(targetDate, requesterId)
        .first();
    }
    if (myCode) {
      rowD = await db
        .prepare("SELECT id, code, period FROM shifts WHERE date = ? AND emp_id = ?")
        .bind(myDate, targetId)
        .first();
    }
  }

  // Final combined state per person per date (null = off that day).
  const requesterFinal = {
    [myDate]: rowD ? { code: rowD.code, period: rowD.period } : null,
    [targetDate]: targetCode ? { code: targetCode, period: targetPeriod } : null,
  };
  const targetFinal = {
    [myDate]: myCode ? { code: myCode, period: myPeriod } : null,
    [targetDate]: rowC ? { code: rowC.code, period: rowC.period } : null,
  };

  const msg1 = await checkRestForFinalStates(db, requesterId, requesterName, requesterFinal);
  if (msg1) return { error: msg1, status: 409 };

  const msg2 = await checkRestForFinalStates(db, targetId, targetName, targetFinal);
  if (msg2) return { error: msg2, status: 409 };

  return { ok: true, rowC, rowD };
}
