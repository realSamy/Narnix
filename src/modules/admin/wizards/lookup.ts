import { Keyboard } from "grammy";
import { ConversationSpec } from "../../../core/module";
import { MyConversation, MyConversationContext } from "../../../types/context";
import { ask, askUsing, confirm, fail, normalizeDigits, ok } from "../../../core/wizard";
import {
  adjustUserBalance,
  buildUserCardKeyboard,
  loadUserRecord,
  renderUserCard,
} from "../lookup";
import { toman } from "../../../utils/format";
import { translatorFor } from "../../../utils/i18n";

export const USER_LOOKUP_CONVERSATION = "admin_user_lookup";
export const USER_ADJUST_CONVERSATION = "admin_user_adjust";

/**
 * Asks for a user, by typed id or through Telegram's own user picker.
 *
 * Same two-shaped answer as the admin-promotion wizard: a `users_shared` service
 * message, or digits. The picker is worth the extra branch — an owner helping someone
 * through a support ticket has their contact card, not their numeric id.
 */
async function askForUser(
  conversation: MyConversation,
  ctx: MyConversationContext,
): Promise<number> {
  const picker = new Keyboard().requestUsers(ctx._("admin.admins.pick_button"), 1).primary().row();
  picker.one_time_keyboard = true;

  return askUsing<number>(
    conversation,
    ctx,
    ctx._("admin.lookup.ask_user"),
    (answer) => {
      if (answer.callbackQuery) return { accepted: false };

      const shared = answer.message?.users_shared?.users?.[0]?.user_id;
      if (shared) return { accepted: true, value: shared };

      const text = answer.message?.text?.trim();
      if (!text) return { accepted: false, complain: ctx._("admin.admins.expects_id") };

      const id = Number(normalizeDigits(text));
      if (!Number.isInteger(id) || id <= 0) {
        return { accepted: false, complain: ctx._("admin.admins.invalid_id") };
      }

      return { accepted: true, value: id };
    },
    { keyboard: picker },
  );
}

/**
 * Look up a user and show their card.
 *
 * The card is sent as a new message rather than an edit. A wizard's prompts are
 * separate messages, so by the time this resolves the admin dashboard is several
 * messages up the chat — editing it would put the answer where nobody is looking.
 */
async function userLookupWizard(
  conversation: MyConversation,
  ctx: MyConversationContext,
): Promise<void> {
  const targetId = await askForUser(conversation, ctx);

  const user = await conversation.external(() => loadUserRecord(ctx.env.DB, targetId));

  if (!user) {
    await ctx.reply(ctx._("admin.lookup.not_found", { id: String(targetId) }), {
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  await ctx.reply(renderUserCard(ctx._, user), {
    reply_markup: buildUserCardKeyboard(ctx._, user.id),
    parse_mode: "HTML",
  });
}

/**
 * Adjust one user's balance.
 *
 * Entered from the user card with the id already known, so it asks for one thing: the
 * signed delta. Everything that can go wrong — the user vanishing mid-wizard, a debit
 * larger than the balance — is settled by `adjustUserBalance` at write time rather
 * than validated here against a balance that was merely true when the prompt was sent.
 */
async function userAdjustWizard(
  conversation: MyConversation,
  ctx: MyConversationContext,
  targetId: number,
): Promise<void> {
  const user = await conversation.external(() => loadUserRecord(ctx.env.DB, targetId));

  if (!user) {
    await ctx.reply(ctx._("admin.lookup.not_found", { id: String(targetId) }), {
      parse_mode: "HTML",
    });
    return;
  }

  const delta = await ask<number>(
    conversation,
    ctx,
    ctx._("admin.lookup.ask_delta", { balance: toman(ctx._, user.balance) }),
    (text) => {
      // Not `askInt`: its `min` defaults to 0, which would reject every debit. The
      // sign is the point of this field. `normalizeDigits` strips grouping and
      // converts Persian digits while leaving a leading `-` intact.
      const value = Number(normalizeDigits(text));

      if (!Number.isFinite(value)) return fail(ctx._("wizard.expects_number"));
      if (!Number.isInteger(value)) return fail(ctx._("wizard.expects_integer"));
      if (value === 0) return fail(ctx._("admin.lookup.no_change"));

      return ok(value);
    },
  );

  const signed = `${delta > 0 ? "➕" : "➖"} ${toman(ctx._, Math.abs(delta))}`;

  // Not ceremony: the delta is free text, and `-500000` is one keystroke away from
  // `-50000`. The adjustment is reversible by another adjustment, but only after the
  // user has already read a notice about money they did not lose.
  const confirmed = await confirm(
    conversation,
    ctx,
    ctx._("admin.lookup.confirm", { id: String(targetId), delta: signed }),
  );

  if (!confirmed) {
    await ctx.reply(ctx._("wizard.cancelled"), { parse_mode: "HTML" });
    return;
  }

  const adminId = ctx.from?.id ?? 0;
  const note = ctx._("admin.lookup.adjust_note");
  const outcome = await conversation.external(() =>
    adjustUserBalance(ctx.env.DB, targetId, delta, adminId, note),
  );

  if (outcome.kind === "gone") {
    await ctx.reply(ctx._("admin.lookup.not_found", { id: String(targetId) }), {
      parse_mode: "HTML",
    });
    return;
  }

  if (outcome.kind === "failed") {
    await ctx.reply(ctx._("admin.lookup.adjust_failed"), { parse_mode: "HTML" });
    return;
  }

  if (outcome.kind === "insufficient") {
    await ctx.reply(
      ctx._("admin.lookup.insufficient", {
        balance: toman(ctx._, outcome.balance),
        delta: toman(ctx._, Math.abs(delta)),
      }),
      { parse_mode: "HTML" },
    );
    return;
  }

  await ctx.reply(
    ctx._("admin.lookup.adjust_done", {
      id: String(targetId),
      delta: signed,
      balance: toman(ctx._, outcome.balance),
    }),
    { parse_mode: "HTML" },
  );

  // Tell the user their balance moved — in *their* language, not the admin's. A
  // balance changing with no explanation is precisely what this feature must not
  // create. A user who has blocked the bot simply cannot be told; that is not an error.
  await notifyUser(conversation, ctx, targetId, delta, outcome.balance);

  // Re-render the card so the admin sees the new figure without paging back.
  await ctx.reply(renderUserCard(ctx._, { ...user, balance: outcome.balance }), {
    reply_markup: buildUserCardKeyboard(ctx._, targetId),
    parse_mode: "HTML",
  });
}

/** Sends the balance-change notice, translated for the recipient. */
async function notifyUser(
  conversation: MyConversation,
  ctx: MyConversationContext,
  targetId: number,
  delta: number,
  balance: number,
): Promise<void> {
  // `translatorFor` is a database read, so it belongs outside the replay log; the
  // `sendMessage` that follows is a Bot API call and must stay inside it.
  const notice = await conversation.external(async () => {
    const _u = await translatorFor(ctx.env.DB, targetId);

    return _u(delta > 0 ? "admin.lookup.notify_credit" : "admin.lookup.notify_debit", {
      amount: toman(_u, Math.abs(delta)),
      balance: toman(_u, balance),
    });
  });

  try {
    await ctx.api.sendMessage(targetId, notice, { parse_mode: "HTML" });
  } catch (err) {
    console.error(`admin adjust: could not notify user ${targetId}`, err);
  }
}

export const userLookupConversation: ConversationSpec = {
  id: USER_LOOKUP_CONVERSATION,
  builder: userLookupWizard,
};

export const userAdjustConversation: ConversationSpec = {
  id: USER_ADJUST_CONVERSATION,
  builder: userAdjustWizard,
};
