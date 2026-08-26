/**
 * Row shapes for the tables in `migrations/0001_baseline.sql`.
 *
 * These are hand-maintained: D1 has no codegen step, so a column added by a migration
 * must be added here too or `first<T>()` will hand you a type that quietly lies. When you
 * add a table, add its interface here in the same order the migration creates it.
 */

/**
 * SQLite boolean representation in Cloudflare D1 (0 = false, 1 = true)
 */
export type SQLiteBoolean = 0 | 1;

/**
 * Lifecycle states for a support ticket
 */
export type TicketStatus = "open" | "pending_admin" | "pending_user" | "closed";

/**
 * Who authored a given ticket message. Matches the values actually written to
 * `ticket_messages.sender_role` — the ticket system is owner-only, so the
 * non-user side is the owner, not a generic admin.
 */
export type TicketMessageSender = "user" | "owner";

/**
 * Telegram content types the ticket system knows how to relay
 */
export type TicketMessageContentType =
  | "text"
  | "photo"
  | "document"
  | "video"
  | "voice"
  | "audio"
  | "sticker"
  | "video_note"
  | "animation";

// ============================================================================
// Database Tables
// ============================================================================

/**
 * Telegram bot user record
 */
export interface User {
  id: number; // Telegram numeric ID
  first_name: string;
  last_name: string | null;
  username: string | null;
  balance: number; // Account balance, in the unit `common.toman` names
  lang: string; // e.g. 'fa' or 'en'
  referral: number | null; // Referrer user ID
  created_at: string; // ISO 8601 string / SQLite DATETIME
  /** Set when Telegram reported the user blocked the bot; NULL = reachable */
  blocked_at: string | null;
  /**
   * Set when this reader asked for plain text instead of rich blocks; NULL = rich.
   *
   * Their own escape hatch for a Telegram client too old to render a rich message —
   * a failure the bot cannot detect, because the send succeeds either way.
   */
  simple_messages_at: string | null;
  /** Set when the one-time "not displaying properly?" notice was sent; NULL = not yet */
  style_hint_at: string | null;
}

/**
 * System administrators
 *
 * The owner is **not** in this table — they come from `env.OWNER`, so the bot has an
 * admin before the first migration has ever run.
 */
export interface Admin {
  user_id: number;
  added_by: number | null;
  created_at: string;
}

/**
 * A support ticket conversation between a user and the owner
 */
export interface Ticket {
  id: number;
  user_id: number;
  subject: string;
  status: TicketStatus;
  user_topic_id: number | null;
  owner_topic_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * A single message within a ticket's conversation history
 */
export interface TicketMessage {
  id: number;
  ticket_id: number;
  sender_id: number;
  sender_role: TicketMessageSender;
  user_msg_id: number | null;
  owner_msg_id: number | null;
  /** Which Telegram content the message carried; NULL-safe default is `'text'`. */
  content_type: TicketMessageContentType;
  /** Text or caption, trimmed to a preview length. NULL for uncaptioned media. */
  preview: string | null;
  /**
   * When the recipient's topic actually received a copy. NULL = still owed to them,
   * which is what the reopen-flush queries look for.
   */
  delivered_at: string | null;
  created_at: string;
}

/**
 * A queued/running/finished broadcast job
 */
export type BroadcastStatus = "queued" | "running" | "done" | "cancelled";

export interface Broadcast {
  id: number;
  /** The message body, already rendered in the language it will be sent in. */
  message: string;
  /** 'HTML' or NULL. Validated against Telegram before the job was queued. */
  parse_mode: string | null;
  created_by: number;
  status: BroadcastStatus;
  /** Keyset cursor: the highest users.id already attempted. 0 = nothing yet. */
  cursor_user_id: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  finished_at: string | null;
}

/**
 * One row of the conversation replay log (`conversations`).
 *
 * Named `…Row` because the conversations plugin already owns the name
 * `Conversation` in this codebase.
 */
export interface ConversationRow {
  key: string; // ctx.chatId, the plugin's default storage key
  data: string; // JSON-serialised VersionedState<ConversationData>
  updated_at: string;
}
