// =============================================================================
// Model definitions — one per D1 table, mirroring `types/database.d.ts`.
//
// `defineModel` makes the `columns` record exhaustive: a column added to the
// row interface without being declared here (or the reverse) is a compile
// error. Table names must match `migrations/0001_baseline.sql` exactly — they
// are inlined into every generated query, and D1 has no way to validate them.
//
// SQLite stores booleans as 0/1 (`SQLiteBoolean` in `types/database.d.ts`);
// write `1`/`0` through this layer, never `true`/`false`.
// =============================================================================

import {
  Admin,
  Broadcast,
  ConversationRow,
  Ticket,
  TicketMessage,
  User,
} from "../../types/database";
import { defineModel } from "./model";

/** Telegram bot users (`users`). */
export const Users = defineModel<User>({
  table: "users",
  key: "id",
  columns: {
    id: 1,
    first_name: 1,
    last_name: 1,
    username: 1,
    balance: 1,
    lang: 1,
    referral: 1,
    created_at: 1,
    blocked_at: 1,
    simple_messages_at: 1,
    style_hint_at: 1,
  },
});

/** Dynamically granted admins (`admins`). */
export const Admins = defineModel<Admin>({
  table: "admins",
  key: "user_id",
  columns: { user_id: 1, added_by: 1, created_at: 1 },
});

/** Support tickets (`tickets`). */
export const Tickets = defineModel<Ticket>({
  table: "tickets",
  key: "id",
  columns: {
    id: 1,
    user_id: 1,
    subject: 1,
    status: 1,
    user_topic_id: 1,
    owner_topic_id: 1,
    created_at: 1,
    updated_at: 1,
  },
  // Every status or topic change to a ticket bumps `updated_at`. Five
  // handwritten UPDATEs used to remember that column each time; the layer
  // now does it for all of them, including the sixth.
  touch: "updated_at",
});

/** Messages within a ticket (`ticket_messages`). */
export const TicketMessages = defineModel<TicketMessage>({
  table: "ticket_messages",
  key: "id",
  columns: {
    id: 1,
    ticket_id: 1,
    sender_id: 1,
    sender_role: 1,
    user_msg_id: 1,
    owner_msg_id: 1,
    content_type: 1,
    preview: 1,
    delivered_at: 1,
    created_at: 1,
  },
});

/**
 * Broadcast jobs (`broadcasts`).
 *
 * Deliberately *no* `touch`: the drain advances `cursor_user_id` every minute
 * and that is not a modification anyone reads. `finished_at` is written
 * explicitly by the completion path, which is a different event from an update.
 */
export const Broadcasts = defineModel<Broadcast>({
  table: "broadcasts",
  key: "id",
  columns: {
    id: 1,
    message: 1,
    parse_mode: 1,
    created_by: 1,
    status: 1,
    cursor_user_id: 1,
    sent_count: 1,
    failed_count: 1,
    created_at: 1,
    finished_at: 1,
  },
});

/**
 * Conversation replay log for @grammyjs/conversations (`conversations`).
 *
 * Written by the storage adapter in `core/conversationStorage.ts` through the
 * `conversations` repository; the `updated_at` index exists so abandoned
 * conversations can be swept.
 */
export const Conversations = defineModel<ConversationRow>({
  table: "conversations",
  key: "key",
  columns: { key: 1, data: 1, updated_at: 1 },
});
