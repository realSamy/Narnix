import { Composer } from "grammy";
import { MyContext, Translator } from "../../types/context";
import { TranslationPath } from "../../types/i18n";
import { BotModule } from "../../core/module";
import { Ticket, TicketStatus } from "../../types/database";
import { openUserTopic, openOwnerTopic, minimizeTopic, closeTicket } from "./topics";
import { buildActiveTicketMenu, buildMessageStyleKeyboard } from "./keyboards";
import { findActiveTicketForUser, findTicketById } from "./repo";
import { getMessageStyle, setMessageStyle } from "../../core/db/repositories/users";
import { ensureUser } from "../start/utils";
import { ticketRelay } from "./relay";
import { TICKET_SUBJECT_CONVERSATION, ticketSubjectConversation } from "./wizards";
import { esc } from "../../core/wizard";

/**
 * `tickets.status` is a database enum, not display copy. It used to be printed
 * straight into the user's chat, so a Persian-speaking customer was told their ticket
 * was `pending_admin`.
 */
const STATUS_LABELS = {
  open: "ticket.status.open",
  pending_admin: "ticket.status.pending_admin",
  pending_user: "ticket.status.pending_user",
  closed: "ticket.status.closed",
} as const satisfies Record<TicketStatus, TranslationPath>;

function statusLabel(_: Translator, status: TicketStatus): string {
  return _(STATUS_LABELS[status] ?? "ticket.status.open");
}

/**
 * Message formatting, switched by whoever is reading — both sides use this one handler.
 *
 * The conversation recap is sent as a rich message, and a Telegram client too old to
 * know that type draws a placeholder instead of the content. The bot cannot tell: the
 * send succeeds, no error comes back, and there is no capability flag on the recipient
 * to check first. So the decision belongs to the only party who can see the result.
 *
 * Reachable two ways on purpose. `offerStyleHint` puts the button on a plain message the
 * first time a recap is sent to an account, and `/simple` is the permanent way in for
 * anyone who dismissed it, cleared the chat, or arrived before the feature existed.
 */
async function applyMessageStyle(ctx: MyContext, simple: boolean): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // The row is what remembers the choice, and someone can reach `/simple` without ever
  // having reached `/start`. Without this the write below would match nothing and the
  // confirmation would promise a setting that was never stored.
  await ensureUser(ctx);
  await setMessageStyle(ctx.env.DB, userId, simple);

  // Sent back into the topic it was triggered from. Passed explicitly rather than left
  // to `ctx.reply` to infer, so the confirmation lands beside the messages it is about
  // instead of in the General topic.
  const threadId = ctx.callbackQuery?.message?.message_thread_id ?? ctx.msg?.message_thread_id;

  // Plain text, always — a confirmation that it is safe to turn rich formatting off is
  // no use to anyone if it needs rich formatting to be read.
  await ctx.reply(ctx._(simple ? "ticket.style_simple_on" : "ticket.style_simple_off"), {
    parse_mode: "HTML",
    reply_markup: buildMessageStyleKeyboard(ctx._, simple),
    ...(threadId ? { message_thread_id: threadId } : {}),
  });
}

const messageStyle = new Composer<MyContext>();

messageStyle.callbackQuery(/^t_simple:([01])$/, async (ctx) => {
  // No toast text: the confirmation below says the same thing and stays on screen.
  await ctx.answerCallbackQuery();
  await applyMessageStyle(ctx, ctx.match[1] === "1");
});

// Toggles rather than only turning simple mode on. A reader who cannot see rich messages
// has no screen to read the current state off, so this command has to be the way back
// as well as the way in.
messageStyle.command("simple", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const style = await getMessageStyle(ctx.env.DB, userId);

  // No row yet means no preference stored, which is the same starting point as a stored
  // NULL: turn simple mode on.
  await applyMessageStyle(ctx, !style.simple);
});

const ticketComposer = new Composer<MyContext>();

// 1. Message-style controls, deliberately ahead of the relay. The relay claims *every*
//    message sent inside a ticket topic and does not call `next()`, so mounted after it
//    a `/simple` typed in a topic would be forwarded to the other side as if it were a
//    support message — the one place the escape hatch is most likely to be reached.
ticketComposer.use(messageStyle);

// 2. Mount bidirectional relay
ticketComposer.use(ticketRelay);

// --- User Support Entrypoint ---
ticketComposer.callbackQuery("user_support", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  // Check if user already has an active ticket
  const activeTicket = await findActiveTicketForUser(ctx.env.DB, userId);

  if (activeTicket) {
    await ctx.editMessageText(
        ctx._("ticket.active_title", {
          id: activeTicket.id,
          // A subject is user-supplied text going into an HTML message; one `<` in it
          // used to turn this screen into a permanent 400.
          subject: esc(activeTicket.subject ?? ""),
          status: statusLabel(ctx._, activeTicket.status),
        }),
        {
          reply_markup: buildActiveTicketMenu(ctx._, activeTicket.id),
          parse_mode: "HTML",
        }
    );
    return;
  }

  await ctx.conversation.enter(TICKET_SUBJECT_CONVERSATION);
});

// --- User Actions ---
ticketComposer.callbackQuery(/^t_open_u:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticketId = parseInt(ctx.match[1], 10);
  const ticket = await findTicketById(ctx.env.DB, ticketId);

  if (!ticket) {
    await ctx.reply(ctx._("ticket.gone"));
    return;
  }

  // `openUserTopic` returns null when the topic can neither be reused nor created —
  // the user has topics turned off, or blocked the bot outright. Saying so beats
  // leaving the button looking broken.
  const threadId = await openUserTopic(ctx, ticket);
  if (threadId === null) {
    await ctx.reply(ctx._("ticket.topic_open_failed"), { parse_mode: "HTML" });
  }
});

ticketComposer.callbackQuery(/^t_min_u:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: ctx._("ticket.minimized_user_alert") });
  const ticketId = parseInt(ctx.match[1], 10);
  await minimizeTopic(ctx, ticketId, false);
});

// --- Owner Actions ---
ticketComposer.callbackQuery(/^t_open_o:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ticketId = parseInt(ctx.match[1], 10);
  const ticket = await findTicketById(ctx.env.DB, ticketId);

  if (!ticket) {
    await ctx.reply(ctx._("ticket.gone"));
    return;
  }

  const threadId = await openOwnerTopic(ctx, ticket);
  if (threadId === null) {
    await ctx.reply(ctx._("ticket.topic_open_failed"), { parse_mode: "HTML" });
  }
});

ticketComposer.callbackQuery(/^t_min_o:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: ctx._("ticket.minimized_owner_alert") });
  const ticketId = parseInt(ctx.match[1], 10);
  await minimizeTopic(ctx, ticketId, true);
});

// --- Close Ticket Handler (Shared) ---
ticketComposer.callbackQuery(/^t_close:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: ctx._("ticket.closed_alert") });
  const ticketId = parseInt(ctx.match[1], 10);
  await closeTicket(ctx, ticketId);
});

export const TicketModule: BotModule = {
  id: "tickets",
  name: "Forum Topic Ticket Support",
  composer: ticketComposer,
  conversations: [ticketSubjectConversation],
};
