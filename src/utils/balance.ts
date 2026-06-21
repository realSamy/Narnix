import { D1Database } from "@cloudflare/workers-types";

/**
 * The two ways a user's balance is allowed to move.
 *
 * Every balance write in the bot went through hand-rolled SQL, and the same subtle
 * invariant had to be remembered at each one: **D1 reports `success: true` even
 * when the WHERE clause matched zero rows.** A conditional debit that only checks
 * `success` therefore reports "paid" for a user who had nothing to pay with. That
 * exact mistake shipped twice — once in the original purchase flow, once in the
 * parallel renewal flow — and both times it handed out a paid service for free.
 *
 * So the check lives here, once, and the callers get a boolean they cannot
 * misread. Two further properties they depend on:
 *
 *  - **Neither function throws.** Refunds run inside `catch` blocks that are
 *    already handling a provisioning failure; a D1 error thrown there would
 *    replace the "your purchase failed, you were refunded" message with a generic
 *    error and lose the explanation. A failure is a logged `false` instead.
 *  - **A failed credit is always logged.** An uncredited refund is money the user
 *    paid and did not get back, which is the one failure mode that must never be
 *    silent.
 *
 * Deliberately *not* here: `adjustUserBalance` in `modules/admin/lookup.ts`. That
 * one takes a signed delta, has to distinguish "no such user" from "would go
 * negative" to word its reply, and writes an audit row — different predicate,
 * different return shape, different job.
 */

/** Rejects the values that would turn an arithmetic write into a silent corruption. */
function isValidAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

/**
 * Takes `amount` from the user's balance, but only if they have it.
 *
 * The balance check and the write are one statement, so two concurrent purchases
 * cannot both pass a check that only one of them can afford. Returns `false` when
 * the user could not pay — including the case where their balance moved between
 * the invoice being rendered and the button being tapped — and the caller must
 * treat that as "nothing was charged".
 *
 * An amount of `0` succeeds: a 100%-off coupon is a real, free purchase.
 */
export async function debitBalance(
  db: D1Database,
  userId: number,
  amount: number,
): Promise<boolean> {
  if (!isValidAmount(amount)) {
    console.error(`debitBalance: refusing invalid amount ${amount} for user ${userId}`);
    return false;
  }

  try {
    const res = await db
      .prepare("UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?")
      .bind(amount, userId, amount)
      .run();

    return res.success && res.meta.changes > 0;
  } catch (err) {
    console.error(`debitBalance: ${amount} from user ${userId} failed`, err);
    return false;
  }
}

/**
 * Adds `amount` to the user's balance.
 *
 * Unconditional — a refund, a deposit or a referral bonus is owed regardless of
 * the current balance — so the only way this returns `false` is a D1 failure or a
 * user row that no longer exists. `label` names the money's origin and appears in
 * the log line, because "credit failed for user 123" is not actionable while
 * "refund:provision_failed failed for user 123" is.
 */
export async function creditBalance(
  db: D1Database,
  userId: number,
  amount: number,
  label = "credit",
): Promise<boolean> {
  if (!isValidAmount(amount)) {
    console.error(`creditBalance(${label}): refusing invalid amount ${amount} for user ${userId}`);
    return false;
  }

  try {
    const res = await db
      .prepare("UPDATE users SET balance = balance + ? WHERE id = ?")
      .bind(amount, userId)
      .run();

    if (!res.success || res.meta.changes === 0) {
      console.error(`creditBalance(${label}): ${amount} to user ${userId} credited nothing`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`creditBalance(${label}): ${amount} to user ${userId} failed`, err);
    return false;
  }
}
