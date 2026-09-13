import { InlineKeyboard } from "grammy";
import { MyContext } from "../../types/context";
import { esc } from "../../core/wizard";
import { toman } from "../../utils/format";
import { translatorFor, normalizeLanguage } from "../../utils/i18n";
import {
  creditBalance,
  ensureUser as ensureUserRecord,
  findUserById,
  redeemReferral,
} from "../../core/db/repositories/users";

/** Credit granted to the inviter the first time a referral link is redeemed. */
export const REFERRAL_BONUS = 20000;

/**
 * Whether a redeemed referral actually pays `REFERRAL_BONUS` into the inviter's
 * balance.
 *
 * Off in this base on purpose. The wallet itself exists — the admin panel's
 * balance lever and the `toman` formatter are built on it — but a template that
 * moves real money the moment someone shares a link is a decision, not a
 * default. Turn this on in a bot that has a wallet and `processReferral` below
 * behaves exactly as it reads.
 *
 * Off, nothing is lost: the link still records the inviter, and the inviter
 * still gets the join notice — only without the amount line.
 *
 * Same shape as the channel lock's `ON_CHECK_FAILURE`: one named constant, one
 * documented flip, no hidden configuration.
 */
export const CREDIT_REFERRAL_BONUS = false;

/**
 * Ensures the user exists in D1 and keeps their name/username updated.
 *
 * `lang` is written on insert only. It is the user's *choice* once they have one,
 * and the value here is derived from the Telegram client language, so updating it
 * on every `/start` would silently revert a deliberate switch. The value comes from
 * `ctx.session.lang` — already resolved by the binder in `core/bot.ts` — so the
 * derivation exists in exactly one place and the session cache and the stored row
 * cannot disagree about a brand-new user.
 *
 * `blocked_at` is cleared, because the only way back into this function is a message
 * from the user, which is proof they have not blocked the bot. Without this a user
 * who blocked, was marked by a failed broadcast, and then came back would stay
 * excluded from every future broadcast forever.
 */
export async function ensureUser(ctx: MyContext): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const lang = ctx.session.lang ?? normalizeLanguage(from.language_code);

  await ensureUserRecord(ctx.env.DB, {
    id: from.id,
    firstName: from.first_name,
    lastName: from.last_name || null,
    username: from.username || null,
    lang,
  });
}

/**
 * Processes pending referral from session (runs safely after channel verification)
 */
export async function processReferral(ctx: MyContext): Promise<void> {
  const newUserId = ctx.from?.id;
  const inviterId = ctx.session.referral;

  if (!newUserId || !inviterId) {
    ctx.session.referral = undefined;
    return;
  }

  // `messages.referral_self_forbidden` and `referral_not_exists` were written for these
  // two branches and then never wired up — both cases just dropped the referral in
  // silence, so a user who shared their own link with themselves saw a normal welcome
  // screen and no explanation of why no credit arrived.
  if (inviterId === newUserId) {
    ctx.session.referral = undefined;
    await ctx.reply(ctx._("messages.referral_self_forbidden"));
    return;
  }

  try {
    // 1. Verify inviter exists in database
    const inviter = await findUserById(ctx.env.DB, inviterId);

    if (!inviter) {
      await ctx.reply(ctx._("messages.referral_not_exists"));
      return;
    }

    // 2. Atomically set referral ONLY IF the user doesn't already have one
    const linked = await redeemReferral(ctx.env.DB, newUserId, inviterId);

    // 3. If successfully linked for the first time, credit (opt-in) and notify
    if (linked) {
      // The credit is its own statement outside the notification try/catch. It used
      // to share one, whose catch was commented "inviter may have blocked the bot;
      // ignore safely" — so a D1 failure on the *credit* was swallowed by a handler
      // written for a Telegram failure, and the referral was consumed (`referral` is
      // now set, so this branch never runs again) without the bonus ever landing.
      // A failed credit is logged by `creditBalance` itself.
      //
      // Gated by `CREDIT_REFERRAL_BONUS`: with the payout off, none of this runs
      // and the notice below goes out without the amount line.
      if (CREDIT_REFERRAL_BONUS &&
          !(await creditBalance(ctx.env.DB, inviterId, REFERRAL_BONUS, "referral_bonus"))) {
        return;
      }

      // The inviter's language, not the new user's. This message lands in the
      // *inviter's* chat, and `ctx._` here is whoever just tapped the link.
      const _i = await translatorFor(ctx.env.DB, inviterId);
      const newUserDisplay =
          ctx.from?.first_name || _i("common.user_with_id", { id: newUserId });

      const notice = CREDIT_REFERRAL_BONUS
        ? _i("messages.referral_added_by_you", {
            newUserId: newUserId.toString(),
            newUserDisplay: esc(newUserDisplay),
            amount: toman(_i, REFERRAL_BONUS),
          })
        : _i("messages.referral_linked_by_you", {
            newUserId: newUserId.toString(),
            newUserDisplay: esc(newUserDisplay),
          });

      try {
        await ctx.api.sendMessage(inviterId, notice, { parse_mode: "HTML" });
      } catch (notifyErr) {
        // Inviter may have blocked the bot. The link is recorded either way, which
        // is the part that matters; they will see the notice next time they open
        // the bot.
      }
    }
  } catch (err) {
    console.error("❌ Error processing referral:", err);
  } finally {
    // Clear session referral so it won't trigger again
    ctx.session.referral = undefined;
  }
}

/**
 * Displays the main menu to the user
 */
export async function showMainMenu(ctx: MyContext, isEdit = false): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // 1. Ensure user is in D1
  await ensureUser(ctx);

  // 2. Process referral from session if present
  await processReferral(ctx);

  // 3. Build referral link
  const botUsername = ctx.me?.username || "NarnixBot";
  const refLink = `https://t.me/${botUsername}?start=ref_${userId}`;
  const shareText = ctx._("main_menu.share_message", { link: refLink });
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(shareText)}`;

  // 4. Build Main Menu Keyboard
  //
  // This is the one place a new bot almost always has to edit, so it is kept deliberately
  // thin: the three rows below are the ones every module in the base actually handles.
  // Add your feature entry points above the share row and keep support/language last —
  // users learn menu positions, and a settings row that moves between releases is worse
  // than one that is slightly out of the way.
  const keyboard = new InlineKeyboard()
      .url(ctx._("main_menu.share_referral"), shareUrl).row()
      .text(ctx._("main_menu.support"), "user_support")
      // Handled by the language module, not this one. A user whose Telegram client
      // reports a language the bot has no copy for silently lands on the default,
      // so there has to be a way to change it from inside the bot.
      .text(ctx._("language.button"), "user_language").row();

  const welcomeText = ctx._("welcome", {
    name: esc(ctx.from?.first_name || ctx._("common.user")),
  });

  if (isEdit && ctx.callbackQuery) {
    await ctx.editMessageText(welcomeText, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  } else {
    await ctx.reply(welcomeText, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  }
}