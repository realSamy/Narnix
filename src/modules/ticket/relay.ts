import { Composer } from "grammy";
import { Message } from "grammy/types";
import { MyContext } from "../../types/context";
import { Ticket } from "../../types/database";
import { openUserTopic } from "./topics";
import { buildOwnerNotificationKeyboard } from "./keyboards";
import { describeForReader, describeMessage, recordMessage } from "./messages";
import { esc } from "../../core/wizard";
import { translatorFor } from "../../utils/i18n";

export const ticketRelay = new Composer<MyContext>();

/**
 * Copies messages between the two sides of a ticket.
 *
 * Every message is written to `ticket_messages` whether or not it could be handed over,
 * because the recipient's topic may not exist at the moment it arrives — either party can
 * minimize theirs, which deletes the thread outright (see `topics.ts`). An undeliverable
 * message is stored with `delivered_at` NULL and flushed into the thread the next time it
 * opens; the alert sent meanwhile quotes it, so the recipient knows what is waiting.
 *
 * This is the fix for the reported bug: the old code announced a message it had nowhere
 * to put and then dropped it, so "open and reply" led to an empty topic.
 */
ticketRelay.on("message", async (ctx, next) => {
  const threadId = ctx.message.message_thread_id;
  const senderId = ctx.from?.id;

  // Ignore messages sent outside topics (General thread / Main menu interactions)
  if (!threadId || !senderId) {
    return next();
  }

  // The topic's own lifecycle events arrive here as messages as well, and creating one
  // produces the first of them — which is why every ticket topic used to answer itself
  // with "this topic is not linked to any open ticket" the moment it opened.
  if (isServiceMessage(ctx.message)) {
    return next();
  }

  const ownerId = Number(ctx.env.OWNER);
  const { contentType, preview } = describeMessage(ctx.message);

  // -------------------------------------------------------------
  // Scenario A: Message from OWNER inside an active ticket topic
  // -------------------------------------------------------------
  if (Number.isFinite(ownerId) && senderId === ownerId) {
    const ticket = await ctx.env.DB.prepare(
        "SELECT * FROM tickets WHERE owner_topic_id = ? AND status != 'closed'"
    )
        .bind(threadId)
        .first<Ticket>();

    if (!ticket) return unlinkedTopic(ctx, threadId, next);

    // Reopen user topic if user minimized it
    let targetUserThreadId = ticket.user_topic_id;
    if (!targetUserThreadId) {
      targetUserThreadId = await openUserTopic(ctx, ticket);
    }

    let forwardedId: number | null = null;
    if (targetUserThreadId) {
      try {
        const forwarded = await ctx.api.copyMessage(ticket.user_id, ctx.chat.id, ctx.message.message_id, {
          message_thread_id: targetUserThreadId,
        });
        forwardedId = forwarded.message_id;
      } catch (err) {
        // The thread was there a moment ago per the ticket row, but the user can delete
        // it from the Telegram UI at any time. Treat it as undeliverable-for-now rather
        // than letting the update throw: `openUserTopic` rebuilds it on the next open,
        // and the message below is what gets replayed into it.
        console.warn(`ticket ${ticket.id}: could not deliver owner reply`, err);
      }
    }

    const recorded = await recordMessage(ctx.env.DB, {
      ticketId: ticket.id,
      senderId,
      senderRole: "owner",
      ownerMsgId: ctx.message.message_id,
      userMsgId: forwardedId,
      contentType,
      preview,
      delivered: forwardedId !== null,
    });

    // A reply that cannot be delivered has to say so. This used to `return` out of an
    // `if (targetUserThreadId)` with no else, so when the user's topic could not be
    // reopened — they blocked the bot, deleted the chat, turned topics off — the owner
    // saw their message sitting in the thread and had every reason to believe it had
    // arrived. Now there are two different truths to tell: stored-and-waiting, or lost.
    if (forwardedId === null) {
      const _o = await translatorFor(ctx.env.DB, ownerId);
      const message = recorded === null
          ? _o("ticket.relay_failed_owner", { id: ticket.id, userId: ticket.user_id })
          : _o("ticket.relay_queued_owner", { id: ticket.id, userId: ticket.user_id });

      await ctx.reply(message, { message_thread_id: threadId, parse_mode: "HTML" });

      // Only the ledger write failing means the reply is actually gone; leave the status
      // alone in that case, since nothing is waiting for the user.
      if (recorded === null) return;
    }

    await ctx.env.DB.prepare("UPDATE tickets SET status = 'pending_user', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(ticket.id)
        .run();

    return;
  }

  // -------------------------------------------------------------
  // Scenario B: Message from USER inside their ticket topic
  // -------------------------------------------------------------
  const ticket = await ctx.env.DB.prepare(
      "SELECT * FROM tickets WHERE user_topic_id = ? AND user_id = ? AND status != 'closed'"
  )
      .bind(threadId, senderId)
      .first<Ticket>();

  if (!ticket) return unlinkedTopic(ctx, threadId, next);

  const ownerValid = Number.isFinite(ownerId);
  let forwardedId: number | null = null;

  // If Owner topic is open, deliver directly to owner thread
  if (ticket.owner_topic_id && ownerValid) {
    try {
      const forwarded = await ctx.api.copyMessage(ownerId, ctx.chat.id, ctx.message.message_id, {
        message_thread_id: ticket.owner_topic_id,
      });
      forwardedId = forwarded.message_id;
    } catch (err) {
      console.warn(`ticket ${ticket.id}: could not deliver user message`, err);
    }
  }

  // Recorded either way — this is the row the old code never wrote when the owner's
  // topic was minimized, which is why the owner's alert pointed at nothing.
  const recorded = await recordMessage(ctx.env.DB, {
    ticketId: ticket.id,
    senderId,
    senderRole: "user",
    userMsgId: ctx.message.message_id,
    ownerMsgId: forwardedId,
    contentType,
    preview,
    delivered: forwardedId !== null,
  });

  if (forwardedId === null && ownerValid) {
    // Owner topic is minimized (or its thread just went away): notify the owner's main
    // chat, quoting the message so the alert carries the content even in the worst case
    // where the ledger write above failed too.
    const _o = await translatorFor(ctx.env.DB, ownerId);

    if (recorded === null) {
      console.error(`ticket ${ticket.id}: user message not recorded; alert preview is all that survives`);
    }

    await ctx.api.sendMessage(
        ownerId,
        _o("ticket.new_message_notice", {
          id: ticket.id,
          userId: senderId,
          name: esc(ctx.from.first_name ?? _o("common.user")),
          subject: esc(ticket.subject ?? ""),
          preview: describeForReader(_o, contentType, preview),
        }),
        {
          reply_markup: buildOwnerNotificationKeyboard(_o, ticket.id),
          parse_mode: "HTML",
        }
    );
  }

  await ctx.env.DB.prepare("UPDATE tickets SET status = 'pending_admin', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(ticket.id)
      .run();
});

/**
 * True for the service messages that can appear inside a ticket topic.
 *
 * Telegram posts one of these into a topic when it is created, renamed, closed, reopened,
 * hidden, or has a message pinned in it. `createForumTopic` in a private chat is a
 * creation, so opening a ticket topic generated one every single time — a message with a
 * `message_thread_id`, no text, and a sender that is neither side of the ticket, which
 * matched neither lookup below and fell straight through to the unlinked-topic notice. It
 * arrives as its own update, after the header and the replayed backlog the bot had already
 * put in the new thread, which is why the stray notice showed up last.
 *
 * There is nothing for the relay to do with them either way: `copyMessage` documents that
 * service messages cannot be copied. Handing them to `next()` keeps them out of the ticket
 * lookups, out of `ticket_messages`, and out of the recipient's alerts.
 *
 * The list is the forum-topic family from the `Message` object plus `pinned_message`,
 * which is the one other service message either party can trigger from inside a topic.
 */
function isServiceMessage(message: Message): boolean {
  return Boolean(
      message.forum_topic_created ||
      message.forum_topic_edited ||
      message.forum_topic_closed ||
      message.forum_topic_reopened ||
      message.general_forum_topic_hidden ||
      message.general_forum_topic_unhidden ||
      message.pinned_message,
  );
}

/**
 * Terminal branch for a message inside a topic that maps to no open ticket.
 *
 * Nothing else in this bot uses private-chat topics, so in a private chat a threaded
 * message with no ticket behind it is always a leftover: a closed ticket's thread the
 * user kept, or a topic they created themselves. Previously it fell through to
 * `next()` and every module in turn declined it, so the user got no answer at all and
 * had no way to know why.
 *
 * Deliberately narrow. Anywhere but a private chat (the admin supergroup has topics of
 * its own), mid-flow, or on a command, it hands the update on untouched. Service messages
 * never get this far — `isServiceMessage` above turns them away before either lookup.
 */
async function unlinkedTopic(
    ctx: MyContext,
    threadId: number,
    next: () => Promise<void>,
): Promise<void> {
  // Commands belong to whoever registered them: `/simple` is mounted ahead of this
  // composer, and anything else should reach its own handler rather than this notice.
  const isCommand = ctx.message?.text?.startsWith("/") ?? false;

  if (ctx.chat?.type !== "private" || ctx.session.step !== "idle" || isCommand) {
    return next();
  }

  await ctx.reply(ctx._("ticket.unlinked_topic"), {
    message_thread_id: threadId,
    parse_mode: "HTML",
  });
}
