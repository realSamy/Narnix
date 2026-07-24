import { Keyboard } from "grammy";
import { ConversationSpec } from "../../../core/module";
import { MyConversation, MyConversationContext } from "../../../types/context";
import { askUsing, normalizeDigits } from "../../../core/wizard";

export const ADMIN_ADD_CONVERSATION = "admin_add";

/**
 * Promotes a user to bot admin.
 *
 * The answer can arrive two ways — as a numeric id typed by hand, or as a
 * `users_shared` service message from Telegram's own user picker — which is why
 * this uses `askUsing` rather than `ask`. The old implementation registered *two*
 * overlapping handlers for the same step (`["message:text","message:users_shared"]`
 * and then `"message:users_shared"` again), the second of which was dead code that
 * would have double-added the admin had the first not always consumed the update.
 */
async function adminAddWizard(
  conversation: MyConversation,
  ctx: MyConversationContext,
): Promise<void> {
  const picker = new Keyboard().requestUsers(ctx._('admin.admins.pick_button'), 1).primary().row();
  picker.one_time_keyboard = true;

  const targetId = await askUsing<number>(
    conversation,
    ctx,
    ctx._('admin.admins.ask_user'),
    (answer) => {
      if (answer.callbackQuery) return { accepted: false };

      const shared = answer.message?.users_shared?.users?.[0]?.user_id;
      if (shared) return { accepted: true, value: shared };

      const text = answer.message?.text?.trim();
      if (!text) {
        return { accepted: false, complain: ctx._('admin.admins.expects_id') };
      }

      const id = Number(normalizeDigits(text));
      if (!Number.isInteger(id) || id <= 0) {
        return { accepted: false, complain: ctx._('admin.admins.invalid_id') };
      }

      return { accepted: true, value: id };
    },
    { keyboard: picker },
  );

  const outcome = await conversation.external(async () => {
    if (String(targetId) === ctx.env.OWNER) return "owner";

    try {
      const res = await ctx.env.DB.prepare(
        "INSERT INTO admins (user_id, added_by) VALUES (?, ?) ON CONFLICT DO NOTHING",
      )
        .bind(targetId, ctx.from?.id)
        .run();

      // `ON CONFLICT DO NOTHING` makes a re-add succeed with zero changed rows,
      // which is the only way to tell "promoted" from "already an admin".
      return res.meta.changes > 0 ? "added" : "already";
    } catch (err) {
      console.error("admin_add: INSERT failed", err);
      return "failed";
    }
  });

  const message = {
    owner: ctx._('admin.admins.is_owner'),
    added: ctx._('admin.admins.added', { id: targetId }),
    already: ctx._('admin.admins.already', { id: targetId }),
    failed: ctx._('admin.admins.add_failed'),
  }[outcome];

  await ctx.reply(message, {
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  });
}

export const adminAddConversation: ConversationSpec = {
  id: ADMIN_ADD_CONVERSATION,
  builder: adminAddWizard,
};
