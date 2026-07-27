import { BotError, GrammyError, HttpError } from "grammy";
import { MyContext } from "../types/context";
import { getTranslator } from "../utils/i18n";
import { isPermanentFailure } from "../jobs/reachability";

/**
 * Telegram rejections that are races rather than faults.
 *
 * All of these are 400s the bot cannot avoid and does not need to report:
 *
 *  - **message is not modified** — by far the most common. Every toggle keyboard
 *    (inbound cart, panel/card/gateway lists) re-renders on tap, and tapping the
 *    same button twice, or double-tapping through a slow round trip, produces an
 *    edit whose result is byte-identical to what is already on screen.
 *  - **message to edit / delete not found** — the user deleted the message, or it
 *    aged past the 48-hour edit window, between the tap and the edit.
 *  - **message can't be edited** — same class: too old, or not ours to edit.
 *  - **query is too old…** — the callback query expired before the handler
 *    finished, or it had already been answered.
 *
 * Surfacing any of these would put an alarming "something went wrong" in front of
 * a user whose action actually succeeded.
 */
const BENIGN_DESCRIPTIONS: readonly RegExp[] = [
  /message is not modified/i,
  /message to edit not found/i,
  /message to delete not found/i,
  /message can't be edited/i,
  /query is too old/i,
];

function isBenign(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    BENIGN_DESCRIPTIONS.some((re) => re.test(err.description))
  );
}

/**
 * Marks a user the bot can no longer reach.
 *
 * Same bookkeeping the cron jobs do (`jobs/reachability.ts`), applied to the
 * interactive path: a 403 raised while answering an update is the same fact as a
 * 403 raised by a broadcast, and recording it here keeps that user out of the next
 * broadcast instead of waiting for the broadcast to rediscover it. `/start` clears
 * the stamp, so a user who comes back is not silenced permanently.
 */
async function stampBlocked(ctx: MyContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.env?.DB) return;

  try {
    await ctx.env.DB.prepare("UPDATE users SET blocked_at = datetime('now') WHERE id = ?")
      .bind(userId)
      .run();
  } catch (err) {
    console.error(`errorHandler: could not stamp blocked_at for ${userId}`, err);
  }
}

/**
 * Tells the user their action failed.
 *
 * Two attempts, in order, because a failed callback-query handler can be in either
 * of two states and they need different replies:
 *
 *  1. **The query was never answered** — the handler died before its
 *     `answerCallbackQuery()`. Telegram is still showing a spinner on the button,
 *     and answering with an alert both clears it and explains why, without adding
 *     a message to the chat.
 *  2. **The query was already answered** — the usual case, since most handlers
 *     answer first and work second. The second answer is rejected, so fall through
 *     to a chat message; otherwise the user sees a cleared spinner and no
 *     explanation at all.
 *
 * Everything is wrapped: this runs *inside* the error handler, so an exception
 * escaping here would be an unhandled rejection with nothing left to catch it. And
 * a user who has blocked the bot makes both attempts fail by definition.
 */
async function notify(ctx: MyContext): Promise<void> {
  // `ctx._` is bound by the i18n middleware in `core/bot.ts`. An error thrown
  // before that ran — a session-storage failure, say — leaves it undefined, and
  // the error handler must not become a second error.
  const _ = typeof ctx._ === "function" ? ctx._ : getTranslator("fa");
  const text = _("common.unexpected_error");

  if (ctx.callbackQuery) {
    try {
      await ctx.answerCallbackQuery({ text, show_alert: true });
      return;
    } catch {
      // Already answered or expired — fall through to a message.
    }
  }

  if (!ctx.chat) return;

  try {
    // `parse_mode: undefined` overrides the Markdown default from
    // `core/parseMode.ts`. Nothing here is formatted, and a stray `_` or `*` in a
    // translated string would make the *notice about a failure* fail to send.
    await ctx.reply(text, { parse_mode: undefined });
  } catch (err) {
    console.error("errorHandler: could not notify user", err);
  }
}

/**
 * The bot's last line of defence, installed as `bot.catch` in `core/bot.ts`.
 *
 * Anything a handler throws lands here. Previously this only logged, which meant a
 * failed action left the user staring at an unchanged screen — or worse, at a
 * button spinning until Telegram expired the query — with no idea whether it had
 * worked. The three jobs now, in order of importance:
 *
 *  1. Say nothing for races the user should not hear about (`isBenign`).
 *  2. Record a permanently unreachable user, and do *not* try to message them.
 *  3. Otherwise, log for the operator and tell the user in their own language.
 *
 * Note what is deliberately absent: any attempt to retry, refund or roll back.
 * Money paths own their compensation (see `shop/index.ts`, which refunds inside
 * its own catch); a generic retry here could not know what had already been
 * committed.
 */
export default async function (err: BotError<MyContext>) {
  const ctx = err.ctx;
  const cause = err.error;
  const updateId = ctx.update?.update_id;

  if (isBenign(cause)) return;

  if (cause instanceof GrammyError) {
    console.error(
      `update ${updateId}: Telegram rejected ${cause.method}: ${cause.error_code} ${cause.description}`,
    );
  } else if (cause instanceof HttpError) {
    console.error(`update ${updateId}: could not reach Telegram`, cause);
  } else {
    console.error(`update ${updateId}: unhandled error`, cause);
  }

  // A 403 (or "chat not found") means every further send to this user fails the
  // same way, so notifying them is pointless — record it and stop.
  if (isPermanentFailure(cause)) {
    await stampBlocked(ctx);
    return;
  }

  await notify(ctx);
}
