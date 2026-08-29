// =============================================================================
// Data handlers for the ticket module's tables: `tickets` + `ticket_messages`.
//
// These two tables are owned by this module and touched by nothing else in the
// codebase, so their handlers live here instead of in `core/db/repositories/` —
// the same ownership rule the module system applies to handlers. Shared tables
// (`users`, `broadcasts`, …) have their handlers in core; a module's own
// schema surface belongs to the module.
//
// The message ledger is the heart of the relay: every relayed message is
// written down whether or not it could be handed over, with `delivered_at`
// recording whether it reached the recipient's thread. Whatever is still owed
// is flushed the next time that thread exists.
// =============================================================================

import { D1Database } from "@cloudflare/workers-types";
import { Ticket, TicketMessage, TicketMessageSender, TicketStatus } from "../../types/database";
import { repo } from "../../core/db/model";
import { TicketMessages, Tickets } from "../../core/db/models";
import { sqlDateTime } from "../../utils/date";

// =============================================================================
// Ticket rows
// =============================================================================

/** One ticket by id, or null — a tapped button can outlive its ticket. */
export function findTicketById(db: D1Database, ticketId: number): Promise<Ticket | null> {
  return repo(db, Tickets).get(ticketId);
}

/**
 * The user's most recent non-closed ticket, newest first.
 *
 * `status != 'closed'` stays raw SQL: the where-shapes are equality / IS NULL /
 * IN, and "any status except" is none of them. It appears exactly twice in the
* codebase (here and the owner-topic lookup below), which is one time fewer
 * than it would take to justify a `Not` wrapper in the generic layer.
 */
export async function findActiveTicketForUser(
  db: D1Database,
  userId: number,
): Promise<Ticket | null> {
  return db
    .prepare(
      "SELECT * FROM tickets WHERE user_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 1",
    )
    .bind(userId)
    .first<Ticket>();
}

/** The open ticket whose topic in the *owner's* chat this thread id belongs to. */
export function findTicketByOwnerTopic(
  db: D1Database,
  threadId: number,
): Promise<Ticket | null> {
  return db
    .prepare("SELECT * FROM tickets WHERE owner_topic_id = ? AND status != 'closed'")
    .bind(threadId)
    .first<Ticket>();
}

/**
 * The open ticket whose topic in the *user's* chat this thread id belongs to.
 *
 * Also binds `user_id`: topic ids are per-chat so the check is belt-and-braces,
 * but the belt is cheap and the failure it prevents is another user's ticket
 * receiving a relayed copy.
 */
export function findTicketByUserTopic(
  db: D1Database,
  threadId: number,
  userId: number,
): Promise<Ticket | null> {
  return db
    .prepare("SELECT * FROM tickets WHERE user_topic_id = ? AND user_id = ? AND status != 'closed'")
    .bind(threadId, userId)
    .first<Ticket>();
}

/**
 * Creates a ticket in the state it is born in: `pending_admin`, with neither
 * topic open yet. Returns the new id, or null when the insert failed.
 */
export async function createTicketRow(
  db: D1Database,
  userId: number,
  subject: string,
): Promise<number | null> {
  const row = await repo(db, Tickets).insertReturning<{ id: number }>({
    user_id: userId,
    subject,
    status: "pending_admin",
  });

  return row?.id ?? null;
}

/** Moves a ticket through its lifecycle. `updated_at` is bumped by the model. */
export async function setTicketStatus(
  db: D1Database,
  ticketId: number,
  status: TicketStatus,
): Promise<void> {
  await repo(db, Tickets).update(ticketId, { status });
}

/** Remembers (or clears, with null) the topic thread in one party's chat. */
export async function setTicketOwnerTopic(
  db: D1Database,
  ticketId: number,
  topicId: number | null,
): Promise<void> {
  await repo(db, Tickets).update(ticketId, { owner_topic_id: topicId });
}

export async function setTicketUserTopic(
  db: D1Database,
  ticketId: number,
  topicId: number | null,
): Promise<void> {
  await repo(db, Tickets).update(ticketId, { user_topic_id: topicId });
}

/** Closes the ticket and detaches both topics. Both sides are notified by the caller. */
export async function closeTicketRow(db: D1Database, ticketId: number): Promise<void> {
  await repo(db, Tickets).update(ticketId, {
    status: "closed",
    user_topic_id: null,
    owner_topic_id: null,
  });
}

// =============================================================================
// The message ledger
// =============================================================================

/** Arguments for one ledger row. `delivered` is false when the recipient has no thread. */
export interface RecordMessageInput {
  ticketId: number;
  senderId: number;
  senderRole: TicketMessageSender;
  /** Message id in the user's chat — the source when the user is the sender. */
  userMsgId: number | null;
  /** Message id in the owner's chat — the source when the owner is the sender. */
  ownerMsgId: number | null;
  contentType: TicketMessage["content_type"];
  preview: string | null;
  delivered: boolean;
}

/**
 * Writes one message to the ledger.
 *
 * Returns the new row id, or null if the insert failed. The caller decides
 * what that means: for a message that could not be delivered either, it is an
 * actual loss and the sender has to be told — the one case where silence
 * would be worse than an error.
 */
export async function recordTicketMessage(
  db: D1Database,
  input: RecordMessageInput,
): Promise<number | null> {
  try {
    const row = await repo(db, TicketMessages).insertReturning<{ id: number }>({
      ticket_id: input.ticketId,
      sender_id: input.senderId,
      sender_role: input.senderRole,
      user_msg_id: input.userMsgId,
      owner_msg_id: input.ownerMsgId,
      content_type: input.contentType,
      preview: input.preview,
      delivered_at: input.delivered ? sqlDateTime() : null,
    });

    return row?.id ?? null;
  } catch (err) {
    console.error(`ticket ${input.ticketId}: could not record message`, err);
    return null;
  }
}

/**
 * Messages still owed to one side, oldest first.
 *
 * "Owed to the owner" means the *user* sent it and it has not been delivered —
 * nobody is ever owed their own messages, so the sender role is the inverse of
 * the recipient. One row over the cap is fetched deliberately: it is how the
 * caller knows to say "and N more" without a second COUNT query.
 */
export async function pendingMessagesFor(
  db: D1Database,
  ticketId: number,
  recipient: TicketMessageSender,
  limit: number,
): Promise<TicketMessage[]> {
  const sender: TicketMessageSender = recipient === "owner" ? "user" : "owner";

  return repo(db, TicketMessages).all(
    { ticket_id: ticketId, sender_role: sender, delivered_at: null },
    { orderBy: ["id"], limit },
  );
}

/**
 * The most recent already-delivered messages, oldest first, for the context digest.
 *
 * `IS NOT NULL` is raw SQL — the mirror image of the layer's `null` → `IS NULL`
 * shape, which only covers the direction the codebase needs in a where-object.
 * Newest-first with a LIMIT, then reversed in memory: ordering ascending
 * instead would need the total row count first to know what to skip — a second
 * query for a result that is at most eight rows long.
 */
export async function recentDeliveredMessages(
  db: D1Database,
  ticketId: number,
  limit: number,
): Promise<TicketMessage[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM ticket_messages
       WHERE ticket_id = ? AND delivered_at IS NOT NULL
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(ticketId, limit)
    .all<TicketMessage>();

  return (rows.results ?? []).reverse();
}

/**
 * Stamps a message delivered, recording the recipient-side message id when
 * there is one.
 *
 * The column written depends on who received it, which is why this is not one
 * generic UPDATE: `user_msg_id` and `owner_msg_id` are ids in two different
 * chats, and putting one in the other's column would leave a row pointing at
 * an unrelated message.
 *
 * Leaving the row pending is the safe failure: it gets offered again on the
 * next reopen, which is a duplicate at worst. Swallowing the error keeps one
 * bad row from aborting the rest of the flush.
 */
export async function markMessageDelivered(
  db: D1Database,
  messageId: number,
  recipient: TicketMessageSender,
  copiedMsgId: number | null,
): Promise<void> {
  const column = recipient === "owner" ? "owner_msg_id" : "user_msg_id";

  try {
    await db
      .prepare(
        `UPDATE ticket_messages
         SET delivered_at = ?, ${column} = COALESCE(?, ${column})
         WHERE id = ? AND delivered_at IS NULL`,
      )
      .bind(sqlDateTime(), copiedMsgId, messageId)
      .run();
  } catch (err) {
    console.error(`ticket message ${messageId}: could not mark delivered`, err);
  }
}
