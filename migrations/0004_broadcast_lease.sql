-- =============================================================================
-- 0004 — Broadcast lease
--
-- A lease column for the drain. The every-minute cron sends one batch per
-- invocation, and two invocations *can* overlap — a slow batch, a retry, a
-- platform blip. Without a lease both SELECT the same job and the same cursor
-- page, and the whole batch is delivered twice. With one, the claim is a
-- conditional UPDATE: only the invocation whose `meta.changes` is 1 sends.
-- =============================================================================

ALTER TABLE broadcasts ADD COLUMN lease_until DATETIME NULL;
