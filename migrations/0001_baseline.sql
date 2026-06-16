-- =============================================================================
-- 0001 — Baseline
--
-- Everything the base needs, in one file. Apply with `pnpm db:migrate` (local) or
-- `pnpm db:migrate:remote` (the real D1 instance).
--
-- Conventions worth keeping as you add migrations of your own:
--
--  * **Never edit an applied migration** — add a new numbered file. `wrangler d1
--    migrations apply` records which files it has run; changing one already recorded
--    means the local and remote schemas diverge with nothing to detect it.
--  * **Guard with `IF NOT EXISTS`.** It makes a migration safe to apply against a
--    database that was partly bootstrapped by hand, which is how most of these start.
--  * **SQLite has no date type.** `DATETIME` columns are text, and every comparison on
--    them is a *string* comparison, so anything written into one must be
--    zero-padded `YYYY-MM-DD HH:MM:SS` in UTC or the ordering silently lies. Write them
--    with `sqlDateTime()` from `src/utils/date.ts`, never `Date.prototype.toISOString`
--    (its `T` and `Z` sort after every space-separated value).
-- =============================================================================

-- Bot users -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users
(
    id         INTEGER PRIMARY KEY, -- Telegram numeric user id
    first_name TEXT     NOT NULL,
    last_name  TEXT     NULL,
    username   TEXT     NULL,
    balance    REAL     DEFAULT 0,  -- Account balance, in whatever unit `common.toman` names
    lang       TEXT     DEFAULT 'fa',
    referral   INTEGER  NULL,
    -- Telegram answers 403 "bot was blocked by the user" forever once someone blocks the
    -- bot. Recording it lets a broadcast skip them instead of burning its rate limit on
    -- sends that can never land. Cleared by `ensureUser` when they /start again, since a
    -- message from them is proof they have not blocked it.
    blocked_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referral) REFERENCES users (id) ON DELETE SET NULL
);

-- Dynamically granted admins --------------------------------------------------
-- The owner is NOT in here — they come from `env.OWNER`, which is what gives the bot an
-- admin before this migration has ever run.
CREATE TABLE IF NOT EXISTS admins
(
    user_id    INTEGER PRIMARY KEY,
    added_by   INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Conversation replay log for @grammyjs/conversations --------------------------
--
-- The plugin persists, per chat, the updates it has received plus the recorded result of
-- every side effect wrapped in `conversation.external()`. It replays the wizard function
-- against that log on each new update.
--
-- This lives in D1 rather than the KV namespace that holds sessions, because the plugin's
-- correctness depends on read-after-write: KV is eventually consistent, and replaying a
-- stale log makes steps repeat or side effects fire twice. Do not "optimise" it into KV.
--
-- `updated_at` exists so abandoned conversations can be swept — a user who walks away
-- mid-wizard leaves a row behind forever otherwise.
CREATE TABLE IF NOT EXISTS conversations
(
    key        TEXT PRIMARY KEY, -- ctx.chatId, the plugin's default storage key
    data       TEXT NOT NULL,    -- JSON-serialised VersionedState<ConversationData>
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations (updated_at);

-- Broadcast jobs --------------------------------------------------------------
-- Queued by the admin wizard, delivered in batches by the every-minute cron in
-- `src/jobs/broadcast.ts`. The job is a row rather than a loop because a Worker
-- invocation cannot outlive its subrequest budget, and a loop that dies partway leaves
-- no record of where it stopped.
CREATE TABLE IF NOT EXISTS broadcasts
(
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The message body, already rendered in the language it will be sent in.
    -- Broadcasts are NOT translated per recipient: the text is whatever the owner typed,
    -- and inventing a translation of it would be worse than sending the original.
    message        TEXT    NOT NULL,
    -- 'HTML' or NULL. Validated by sending a preview to the author before the job is
    -- created, so a malformed tag fails once instead of on every recipient.
    parse_mode     TEXT,
    created_by     INTEGER NOT NULL,
    -- queued | running | done | cancelled
    status         TEXT     DEFAULT 'queued',
    -- Keyset cursor: the highest users.id already attempted. 0 = nothing yet.
    cursor_user_id INTEGER  DEFAULT 0,
    sent_count     INTEGER  DEFAULT 0,
    failed_count   INTEGER  DEFAULT 0,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at    DATETIME,
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE
);

-- The drain query asks for "the oldest job that still has work". Partial indexes are
-- supported by SQLite and keep this to the handful of live rows rather than every
-- broadcast ever sent.
CREATE INDEX IF NOT EXISTS idx_broadcasts_live
    ON broadcasts (id) WHERE status IN ('queued', 'running');

-- Makes the per-batch "next N reachable users after the cursor" query an index scan
-- instead of a table scan with a filter.
CREATE INDEX IF NOT EXISTS idx_users_reachable
    ON users (id) WHERE blocked_at IS NULL;

-- Support tickets -------------------------------------------------------------
-- Tickets are relayed between forum topics in the *user's* private chat and forum topics
-- in the *owner's* private chat (Bot API 9.3+). Both sides require the Topics feature to
-- be enabled — see `docs/setup.md`, it is not something the bot can turn on itself.
CREATE TABLE IF NOT EXISTS tickets
(
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    subject        TEXT    NOT NULL,
    status         TEXT     DEFAULT 'open', -- open | pending_admin | pending_user | closed
    user_topic_id  INTEGER  NULL,           -- message_thread_id in the user's chat
    owner_topic_id INTEGER  NULL,           -- message_thread_id in the owner's chat
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets (user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);

CREATE TABLE IF NOT EXISTS ticket_messages
(
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id    INTEGER NOT NULL,
    sender_id    INTEGER NOT NULL,
    sender_role  TEXT    NOT NULL, -- 'user' | 'owner'
    user_msg_id  INTEGER NULL,
    owner_msg_id INTEGER NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages (ticket_id);
