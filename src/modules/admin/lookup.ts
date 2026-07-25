import { InlineKeyboard } from "grammy";
import { D1Database } from "@cloudflare/workers-types";
import { MyContext, Translator } from "../../types/context";
import { esc } from "../../core/wizard";
import { toman } from "../../utils/format";
import { formatShamsiDate } from "../../utils/date";
import { normalizeLanguage } from "../../utils/i18n";

/**
 * The admin's view of one user: who they are, and one lever.
 *
 * Every admin screen in a bot tends to end up being about *inventory* — the things you
 * sell, host, or configure — and none about the people using it. This screen is the
 * counterweight, and it is in the base because the question it answers ("this person says
 * X happened and it didn't") comes up in every bot, long before there is any inventory.
 *
 * Extend `UserRecord` and `loadUserRecord` with whatever your bot's users own. Add the
 * matching placeholders to the `admin.lookup.card` locale key and a row to
 * `buildUserCardKeyboard` for anything that needs its own screen.
 */

/** Everything the user card displays, in one query. */
export interface UserRecord {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  balance: number;
  lang: string | null;
  blocked_at: string | null;
  created_at: string;
}

/**
 * Loads one user.
 *
 * When you add per-user counts here, make them **correlated subqueries, not JOINs**. A
 * JOIN against two child tables multiplies their rows together and inflates each count by
 * the other's cardinality — the classic fan-out — and reaching for `COUNT(DISTINCT ...)`
 * to paper over it costs more than the indexed lookups would have:
 *
 * ```sql
 * (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders
 * ```
 */
export async function loadUserRecord(
  db: D1Database,
  userId: number,
): Promise<UserRecord | null> {
  return await db
    .prepare(
      `SELECT u.id,
              u.first_name,
              u.last_name,
              u.username,
              u.balance,
              u.lang,
              u.blocked_at,
              u.created_at
         FROM users u
        WHERE u.id = ?`,
    )
    .bind(userId)
    .first<UserRecord>();
}

/** The user card, rendered. Pure, so a wizard can call it after an adjustment. */
export function renderUserCard(_: Translator, user: UserRecord): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");

  return _("admin.lookup.card", {
    id: String(user.id),
    // Names and usernames are user-controlled and arrive verbatim from Telegram;
    // this message is HTML.
    name: esc(name || _("common.unnamed_user")),
    username: user.username ? `@${esc(user.username)}` : _("common.no_username"),
    lang: normalizeLanguage(user.lang).toUpperCase(),
    balance: toman(_, user.balance),
    joined: formatShamsiDate(user.created_at),
    reachable: user.blocked_at
      ? _("admin.lookup.reachable_blocked")
      : _("admin.lookup.reachable_ok"),
  });
}

export function buildUserCardKeyboard(_: Translator, userId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(_("admin.lookup.adjust_button"), `admin_user_adjust:${userId}`)
    .row()
    .text(_("admin.lookup.refresh_button"), `admin_user_view:${userId}`)
    .row()
    .text(_("common.back"), "admin_main");
}

/** Renders (or re-renders) the card for `userId` in place. */
export async function showUserCard(ctx: MyContext, userId: number): Promise<void> {
  const user = await loadUserRecord(ctx.env.DB, userId);

  if (!user) {
    await ctx.editMessageText(ctx._("admin.lookup.not_found", { id: String(userId) }), {
      reply_markup: new InlineKeyboard().text(ctx._("common.back"), "admin_main"),
      parse_mode: "HTML",
    });
    return;
  }

  await ctx.editMessageText(renderUserCard(ctx._, user), {
    reply_markup: buildUserCardKeyboard(ctx._, user.id),
    parse_mode: "HTML",
  });
}

/** Outcome of an adjustment attempt, as reported back to the admin. */
export type AdjustOutcome =
  | { kind: "ok"; balance: number }
  | { kind: "insufficient"; balance: number }
  | { kind: "gone" }
  | { kind: "failed" };

/**
 * Moves a user's balance by `delta` and records why.
 *
 * The guard is in the UPDATE itself (`balance + ? >= 0`), not in a preceding SELECT:
 * between a read and a write the user can spend, and a debit checked against a stale
 * balance would drive the account negative. `meta.changes` distinguishes "did not match"
 * from "no such user", which is why the row is re-read on failure rather than assumed.
 *
 * The `note` currently only reaches the console. If your bot grows a ledger table, write
 * the audit row here — *after* the balance moves, and with its own try/catch that only
 * logs. The money has already moved by that point, and failing the whole operation
 * because the audit insert failed would be strictly worse than an audit gap.
 */
export async function adjustUserBalance(
  db: D1Database,
  userId: number,
  delta: number,
  adminId: number,
  note: string,
): Promise<AdjustOutcome> {
  let res;
  try {
    res = await db
      .prepare("UPDATE users SET balance = balance + ? WHERE id = ? AND balance + ? >= 0")
      .bind(delta, userId, delta)
      .run();
  } catch (err) {
    console.error("admin adjust: UPDATE failed", err);
    return { kind: "failed" };
  }

  if (!res.success || res.meta.changes === 0) {
    const current = await db
      .prepare("SELECT balance FROM users WHERE id = ?")
      .bind(userId)
      .first<{ balance: number }>();

    if (!current) return { kind: "gone" };
    return { kind: "insufficient", balance: current.balance };
  }

  const after = await db
    .prepare("SELECT balance FROM users WHERE id = ?")
    .bind(userId)
    .first<{ balance: number }>();

  console.log(`admin adjust: user ${userId} delta ${delta} by admin ${adminId} — ${note}`);

  return { kind: "ok", balance: after?.balance ?? 0 };
}
