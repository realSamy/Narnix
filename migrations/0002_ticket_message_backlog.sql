-- =============================================================================
-- 0002 — Ticket message delivery ledger
--
-- Fixes a real delivery bug and adds the context both sides need to pick a
-- conversation back up.
--
-- **The bug.** A ticket has two forum topics, one in each party's private chat, and
-- either side can minimize theirs (`minimizeTopic` deletes the thread and NULLs the
-- stored id — there is no reversible "close" for private-chat topics; only create, edit
-- and delete were extended to private chats in Bot API 9.3). When a message arrived for
-- a side whose thread was gone, the relay announced it in that party's main chat and
-- then dropped it: no copy was made, and — in the user→owner direction — no
-- `ticket_messages` row was written at all. Tapping "open and reply" built a *fresh*
-- topic, so the recipient got an alert, opened the thread, and found it empty. The
-- message survived only in the sender's own thread.
--
-- **The fix.** Every relayed message is now recorded when it arrives, whether or not it
-- could be delivered, and `delivered_at` says which. A message with `delivered_at IS
-- NULL` is a message the recipient has never been shown; opening or reopening that
-- side's topic flushes them into the new thread in order, oldest first.
--
--   * `delivered_at` is a nullable timestamp rather than a boolean flag. The test is the
--     same (`IS NULL` = still pending) and it costs nothing to also know *when* a
--     message finally landed, which is exactly the question asked when someone reports
--     "I never got this".
--   * `preview` and `content_type` exist so a message can be *described* without
--     re-fetching it from Telegram: the alert quotes it, and the digest sent into a
--     freshly opened topic reconstructs the thread from these two columns alone. Media
--     has no text of its own, hence the type — "📷 photo" is a usable line, an empty
--     one is not.
--
-- Note there is no `IF NOT EXISTS` below: SQLite supports it for tables and indexes but
-- not for `ADD COLUMN`. That is fine because wrangler records which migrations it has
-- applied and never re-runs one, but it does mean this is the one file here that cannot
-- be replayed by hand against an already-migrated database.
-- =============================================================================

-- Which Telegram content the message carried; one of the `TicketMessageContentType`
-- values in `src/types/database.d.ts`. Defaulted rather than backfilled: every row
-- written before this migration came through the old relay, which recorded no type.
ALTER TABLE ticket_messages
    ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text';

-- The message text or media caption, trimmed to a preview length by
-- `describeMessage()`. NULL for media with no caption.
ALTER TABLE ticket_messages
    ADD COLUMN preview TEXT NULL;

-- When the recipient's thread actually received a copy. NULL = still owed to them.
ALTER TABLE ticket_messages
    ADD COLUMN delivered_at DATETIME NULL;

-- Anything already carrying both message ids was copied successfully under the old code,
-- so it is delivered; its exact delivery time is unrecoverable, and `created_at` is
-- right to within the length of one relay. Rows holding only one id are the half-relayed
-- messages this migration exists for — they stay NULL and get flushed on the next
-- reopen, which is the closest thing to a repair available.
UPDATE ticket_messages
SET delivered_at = created_at
WHERE user_msg_id IS NOT NULL
  AND owner_msg_id IS NOT NULL
  AND delivered_at IS NULL;

-- The flush query is "everything still owed on this ticket, oldest first". Partial, so
-- it indexes only the small set of undelivered rows rather than every message ever sent.
CREATE INDEX IF NOT EXISTS idx_ticket_messages_pending
    ON ticket_messages (ticket_id, id) WHERE delivered_at IS NULL;
