import { ConversationSpec } from "../../core/module";
import { MyContext, MyConversation, MyConversationContext } from "../../types/context";
import { askText, esc } from "../../core/wizard";
import { Ticket } from "../../types/database";
import { openUserTopic } from "./topics";
import { buildOwnerNotificationKeyboard } from "./keyboards";
import { translatorFor } from "../../utils/i18n";

export const TICKET_SUBJECT_CONVERSATION = "ticket_subject";

/** A topic title has to fit in 128 characters, and the subject shares it with `#<id>: `. */
const MAX_SUBJECT_LENGTH = 100;

/**
 * Everything that happens once a subject has been captured: the ticket row, the user's
 * forum topic, and the owner's notification.
 *
 * Lives outside the conversation so it can be wrapped in a single
 * `conversation.external()` — one recorded side effect instead of a D1 write, an API
 * call and a second D1 write that each need their own replay guard.
 *
 * The return type is deliberately plain JSON: `external` serialises whatever it returns
 * into the replay log, so a `Translator` or a `Ticket` with methods could not cross
 * this boundary.
 */
async function createTicket(
  ctx: MyContext,
  subject: string,
): Promise<{ id: number; topicOpened: boolean } | null> {
  const userId = ctx.from?.id;
  if (!userId) return null;

  const row = await ctx.env.DB.prepare(
    "INSERT INTO tickets (user_id, subject, status) VALUES (?, ?, 'pending_admin') RETURNING id",
  )
    .bind(userId, subject)
    .first<{ id: number }>();

  if (!row) return null;

  const ticket: Ticket = {
    id: row.id,
    user_id: userId,
    subject,
    status: "pending_admin",
    user_topic_id: null,
    owner_topic_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const threadId = await openUserTopic(ctx, ticket);

  // Notify the owner — in the *owner's* language, since this lands in their chat.
  const ownerId = Number(ctx.env.OWNER);
  if (Number.isFinite(ownerId)) {
    try {
      const _o = await translatorFor(ctx.env.DB, ownerId);
      await ctx.api.sendMessage(
        ownerId,
        _o("ticket.owner_new_ticket", {
          id: ticket.id,
          userId,
          name: esc(ctx.from?.first_name || _o("common.user")),
          subject: esc(subject),
        }),
        {
          reply_markup: buildOwnerNotificationKeyboard(_o, ticket.id),
          parse_mode: "HTML",
        },
      );
    } catch (err) {
      // The ticket exists either way; a failed notification must not lose it.
      console.error("Failed to notify owner of new ticket:", err);
    }
  }

  return { id: ticket.id, topicOpened: threadId !== null };
}

/**
 * Asks for a ticket subject, then opens the ticket.
 *
 * Replaces the `awaiting_ticket_subject` step, which was a string cast outside the
 * `Step` union (`as any`) and lived in an `on("message:text")` handler that had to be
 * consulted on every text message in the bot. Two bugs go with it:
 *
 *  - The subject was taken raw with no length bound, so anything past ~120 characters
 *    silently produced a topic title Telegram rejected, and the ticket ended up with
 *    no thread at all.
 *  - The success message was sent unconditionally, so a user whose topic could not be
 *    created was told "your conversation topic is open" and then waited in a thread
 *    that did not exist.
 */
async function ticketSubjectWizard(
  conversation: MyConversation,
  ctx: MyConversationContext,
): Promise<void> {
  const subject = await askText(conversation, ctx, ctx._("ticket.ask_subject"), {
    maxLength: MAX_SUBJECT_LENGTH,
  });

  // One `external` for the whole side effect. It receives the *outer* context — the one
  // carrying `env`, `api` and `from` — and runs exactly once no matter how many times
  // the conversation replays.
  const outcome = await conversation.external((outer) => createTicket(outer, subject));

  if (!outcome) {
    await ctx.reply(ctx._("ticket.create_failed"));
    return;
  }

  await ctx.reply(
    outcome.topicOpened
      ? ctx._("ticket.created")
      : ctx._("ticket.created_no_topic", { id: outcome.id }),
    { parse_mode: "HTML" },
  );
}

export const ticketSubjectConversation: ConversationSpec = {
  id: TICKET_SUBJECT_CONVERSATION,
  builder: ticketSubjectWizard,
};
