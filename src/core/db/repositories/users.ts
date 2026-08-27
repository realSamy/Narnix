// =============================================================================
// Data handlers for the `users` table.
//
// Every read or write of a user row in the bot goes through one of the
// functions in this file. Modules, jobs and core utilities call these with
// domain-shaped arguments; none of them see SQL. Hand-written statements live
// *here*, next to the invariant each one protects, so the reasoning is
// impossible to separate from the query it belongs to.
//
// Error policy matches the rest of the codebase: functions return `null`,
// `false` or a typed outcome instead of throwing where the caller has a
// recoverable branch, and every swallowed failure is logged.
// =============================================================================

import { D1Database } from "@cloudflare/workers-types";
import { User } from "../../../types/database";
import { repo } from "../model";
import { Users } from "../models";
import { sqlDateTime } from "../../../utils/date";

/** The `users` row for one Telegram user id, or null if they have never /started. */
export function findUserById(db: D1Database, userId: number): Promise<User | null> {
  return repo(db, Users).get(userId);
}

/**
 * Ensures the user exists and keeps their name/username current.
 *
 * `lang` is written on insert only. It is the user's *choice* once they have
 * one, and the value on insert is derived from the Telegram client language, so
 * updating it on every `/start` would silently revert a deliberate switch.
 *
 * `blocked_at` is cleared on conflict, because the only way into this function
 * is a message from the user — proof they have not blocked the bot. Without
 * this a user marked by a failed broadcast who later came back would stay
 * excluded from every future broadcast forever.
 *
 * This is raw SQL rather than `repo().upsert()` on purpose: the update writes
 * `blocked_at = NULL`, which has no `excluded.` counterpart — the insert
 * deliberately does not carry the column. Keeping the statement here, with this
 * comment, is cheaper than teaching the generic layer a fifth where-shape.
 */
export async function ensureUser(
  db: D1Database,
  user: {
    id: number;
    firstName: string;
    lastName: string | null;
    username: string | null;
    lang: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO users (id, first_name, last_name, username, lang)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           first_name = excluded.first_name,
           last_name = excluded.last_name,
           username = excluded.username,
           blocked_at = NULL`,
      )
      .bind(user.id, user.firstName, user.lastName, user.username, user.lang)
      .run();
  } catch (err) {
    console.error("❌ Failed to ensure user in D1 database:", err);
  }
}

// =============================================================================
// Language
// =============================================================================

/** Persists a language choice. Returns whether a row was actually updated. */
export async function setUserLanguage(
  db: D1Database,
  userId: number,
  lang: string,
): Promise<boolean> {
  const changes = await repo(db, Users).update(userId, { lang });
  return changes > 0;
}

// =============================================================================
// Reachability — the `blocked_at` stamp
// =============================================================================

/** Marks one user unreachable (Telegram 403 / "chat not found"). */
export async function stampBlocked(db: D1Database, userId: number): Promise<void> {
  await repo(db, Users).update(userId, { blocked_at: sqlDateTime() });
}

/**
 * The statement form of `stampBlockedMany`, for callers that are already
 * batching statements against other tables and want the stamp in the same
 * round trip (the broadcast drain does exactly that). One subrequest instead
 * of two.
 */
export function stampBlockedStatement(db: D1Database, userIds: number[]): D1PreparedStatement {
  const holes = userIds.map(() => "?").join(", ");
  return db
    .prepare(`UPDATE users SET blocked_at = ? WHERE id IN (${holes})`)
    .bind(sqlDateTime(), ...userIds);
}

/** Marks many users unreachable in one statement. No-op on an empty list. */
export async function stampBlockedMany(db: D1Database, userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  await stampBlockedStatement(db, userIds).run();
}

// =============================================================================
// Referral
// =============================================================================

/**
 * Atomically records a referral — but only if the user does not have one.
 *
 * The predicate lives in the UPDATE, not in a preceding SELECT, so two tabs
 * opening the same deep link concurrently cannot both win. Returns false when
 * the user had already been referred (or no longer exists); the caller treats
 * that as "nothing was consumed" rather than an error.
 */
export async function redeemReferral(
  db: D1Database,
  userId: number,
  referrerId: number,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE users SET referral = ? WHERE id = ? AND referral IS NULL")
    .bind(referrerId, userId)
    .run();

  return result.success && result.meta.changes > 0;
}

// =============================================================================
// Balance
// =============================================================================

/** Rejects the values that would turn an arithmetic write into a silent corruption. */
function isValidAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

/**
 * Takes `amount` from the user's balance, but only if they have it.
 *
 * The balance check and the write are one statement, so two concurrent
 * purchases cannot both pass a check that only one of them can afford.
 * Returns `false` when the user could not pay — including the case where their
 * balance moved between the invoice being rendered and the button being tapped
 * — and the caller must treat that as "nothing was charged". An amount of `0`
 * succeeds: a 100%-off coupon is a real, free purchase.
 *
 * Never throws: refunds run inside catch blocks that are already handling a
 * provisioning failure, and a D1 error there would replace the explanation
 * with a generic one. A failure is a logged `false` instead.
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
 * Unconditional — a refund, a deposit or a referral bonus is owed regardless
 * of the current balance — so the only way this returns `false` is a D1
 * failure or a user row that no longer exists. `label` names the money's
 * origin and appears in the log line, because "credit failed for user 123" is
 * not actionable while "refund:provision_failed failed for user 123" is.
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

/** Outcome of a signed balance adjustment, as the admin card reports it. */
export type BalanceAdjustment =
  | { ok: true; balance: number }
  | { ok: false; reason: "gone" | "failed" }
  | { ok: false; reason: "insufficient"; balance: number };

/**
 * Moves a balance by a signed `delta`, refusing to drive the account negative.
 *
 * The guard is in the UPDATE itself (`balance + ? >= 0`), not in a preceding
 * SELECT: between a read and a write the user can spend, and a debit checked
 * against a stale balance would drive the account negative. `meta.changes`
 * distinguishes "did not match" from "no such user", which is why the row is
 * re-read on failure rather than assumed. Deliberately distinct from
 * `creditBalance`/`debitBalance`: different predicate, different outcome
 * shape, different job — this one is an admin lever with a human reading the
 * result, those are money-path primitives.
 */
export async function adjustBalance(
  db: D1Database,
  userId: number,
  delta: number,
): Promise<BalanceAdjustment> {
  let res;
  try {
    res = await db
      .prepare("UPDATE users SET balance = balance + ? WHERE id = ? AND balance + ? >= 0")
      .bind(delta, userId, delta)
      .run();
  } catch (err) {
    console.error("adjustBalance: UPDATE failed", err);
    return { ok: false, reason: "failed" };
  }

  const current = await findUserById(db, userId);

  if (!res.success || res.meta.changes === 0) {
    if (!current) return { ok: false, reason: "gone" };
    return { ok: false, reason: "insufficient", balance: current.balance };
  }

  return { ok: true, balance: current?.balance ?? 0 };
}

// =============================================================================
// Broadcast audience
// =============================================================================

/** How many users a broadcast would currently attempt. */
export async function countReachable(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM users WHERE blocked_at IS NULL")
    .first<{ total: number }>();

  return row?.total ?? 0;
}

/**
 * The next page of reachable user ids after a keyset cursor.
 *
 * Selects only `id`, making the query an index scan on `idx_users_reachable`
 * that never touches the table — the drain runs this every minute, and `SELECT
 * *` here would drag every user column along for no reason.
 */
export async function listReachableIdsAfter(
  db: D1Database,
  cursorUserId: number,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .prepare("SELECT id FROM users WHERE id > ? AND blocked_at IS NULL ORDER BY id LIMIT ?")
    .bind(cursorUserId, limit)
    .all<{ id: number }>();

  return (rows.results ?? []).map((row) => row.id);
}

// =============================================================================
// Message style (rich vs. simple) — columns on `users`, owned by the ticket UI
// =============================================================================

/** What one reader has decided about rich formatting, and whether they were ever asked. */
export interface MessageStyle {
  simple: boolean;
  hinted: boolean;
}

/**
 * Reads a reader's formatting preference.
 *
 * `hinted: true` for a user with no row at all, which looks backwards but is
 * the safe default: the hint is suppressed rather than offered. A missing row
 * means `stampStyleHint` would update nothing, so the "once per account"
 * promise could never be kept and the notice would reappear on every single
 * topic open.
 */
export async function getMessageStyle(
  db: D1Database,
  userId: number,
): Promise<MessageStyle> {
  try {
    const row = await db
      .prepare("SELECT simple_messages_at, style_hint_at FROM users WHERE id = ?")
      .bind(userId)
      .first<{ simple_messages_at: string | null; style_hint_at: string | null }>();

    if (!row) return { simple: false, hinted: true };

    return { simple: row.simple_messages_at !== null, hinted: row.style_hint_at !== null };
  } catch (err) {
    // Rich is the better guess when the preference is unreadable: it is what
    // the vast majority of clients render correctly, and `hinted: true` keeps
    // a database blip from spending the one-time notice.
    console.error(`could not read message style for ${userId}:`, err);
    return { simple: false, hinted: true };
  }
}

/** Records the reader's choice. `null` restores rich formatting. */
export async function setMessageStyle(
  db: D1Database,
  userId: number,
  simple: boolean,
): Promise<void> {
  await repo(db, Users).update(userId, {
    simple_messages_at: simple ? sqlDateTime() : null,
  });
}

/** Stamps the one-time "not displaying properly?" notice as sent. */
export async function stampStyleHint(db: D1Database, userId: number): Promise<void> {
  await repo(db, Users).update(userId, { style_hint_at: sqlDateTime() });
}
