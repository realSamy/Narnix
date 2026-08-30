import { ConversationSpec } from "../../../core/module";
import { GrammyError } from "grammy";
import { MyConversation, MyConversationContext } from "../../../types/context";
import { askText, confirm, esc } from "../../../core/wizard";
import { createBroadcast, hasLiveBroadcast } from "../../../core/db/repositories/broadcasts";
import { countReachable } from "../../../core/db/repositories/users";

export const BROADCAST_CONVERSATION = "admin_broadcast";

/**
 * Composes a broadcast and queues it.
 *
 * The send itself is *not* here. A broadcast to N users is N `sendMessage`
 * subrequests, and one Worker invocation gets 50 of them on the Free plan — so past
 * a few dozen users an in-handler loop would simply stop partway through with no
 * record of where it got to. This writes one `broadcasts` row and the cron job in
 * `src/jobs/broadcast.ts` drains it a batch at a time.
 *
 * Telegram's own 4096-character message limit is the cap here, minus room for the
 * `/cancel` footer the prompt helper appends.
 */
const MAX_BODY = 3500;

/** How many times the author may fail HTML validation before the wizard gives up. */
const MAX_MARKUP_ATTEMPTS = 3;

/**
 * Asks for the body and proves it renders.
 *
 * Validation is a real `sendMessage` to the author, not a local tag parser: Telegram's
 * accepted subset of HTML is not something a regex here could match, and a body that
 * fails on the first recipient would strand a half-delivered broadcast. Sending it
 * once to the person who wrote it costs one message and settles the question.
 *
 * Bot API calls inside a conversation are replayed from a recorded log rather than
 * re-issued, and this particular failure is recorded rather than escaping: grammY's
 * `callApi` sits *above* the transformer stack, so a Telegram-level error arrives at the
 * conversation's recording transformer as an ordinary `ok: false` response and is
 * journalled like any other result — the `GrammyError` is only minted afterwards, on the
 * way back out. So the same rejection is thrown again on every replay, and this
 * try/catch is deterministic. The attempt cap bounds how long that log can grow.
 */
async function askForBody(
  conversation: MyConversation,
  ctx: MyConversationContext,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_MARKUP_ATTEMPTS; attempt++) {
    const body = await askText(conversation, ctx, ctx._("admin.broadcast.ask_message"), {
      maxLength: MAX_BODY,
    });

    try {
      await ctx.reply(ctx._("admin.broadcast.preview"), { parse_mode: "HTML" });
      await ctx.reply(body, { parse_mode: "HTML" });
      return body;
    } catch (err) {
      // `description` is what Telegram says is wrong with the markup ("Unsupported
      // start tag …"), and it is far more useful to the author than the wrapper.
      // It is escaped because it quotes the offending markup back at us, and an
      // unescaped `<` in a `parse_mode: "HTML"` message would throw from inside this
      // very catch block.
      const detail = err instanceof GrammyError ? err.description : String(err);
      await ctx.reply(ctx._("admin.broadcast.invalid_markup", { error: esc(detail) }), {
        parse_mode: "HTML",
      });
    }
  }

  return null;
}

async function broadcastWizard(
  conversation: MyConversation,
  ctx: MyConversationContext,
): Promise<void> {
  // A second live broadcast would interleave with the first: the drain job takes the
  // oldest live row, so the newer one would sit queued behind it for however long the
  // first takes — long enough that the author would reasonably assume it was lost.
  const live = await conversation.external(() => hasLiveBroadcast(ctx.env.DB));

  if (live) {
    await ctx.reply(ctx._("admin.broadcast.running"), { parse_mode: "HTML" });
    return;
  }

  const body = await askForBody(conversation, ctx);
  if (body === null) {
    await ctx.reply(ctx._("admin.broadcast.cancelled"), { parse_mode: "HTML" });
    return;
  }

  const recipients = await conversation.external(() => countReachable(ctx.env.DB));

  const confirmed = await confirm(
    conversation,
    ctx,
    ctx._("admin.broadcast.confirm", { count: String(recipients) }),
  );

  if (!confirmed) {
    await ctx.reply(ctx._("admin.broadcast.cancelled"), { parse_mode: "HTML" });
    return;
  }

  const authorId = ctx.from?.id ?? Number(ctx.env.OWNER);

  const jobId = await conversation.external(async () => {
    try {
      return await createBroadcast(ctx.env.DB, {
        message: body,
        parseMode: "HTML",
        createdBy: authorId,
      });
    } catch (err) {
      console.error("broadcast: INSERT failed", err);
      return null;
    }
  });

  if (jobId === null) {
    await ctx.reply(ctx._("admin.broadcast.queue_failed"), { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(ctx._("admin.broadcast.queued", { id: String(jobId) }), {
    parse_mode: "HTML",
  });
}

export const broadcastConversation: ConversationSpec = {
  id: BROADCAST_CONVERSATION,
  builder: broadcastWizard,
};
