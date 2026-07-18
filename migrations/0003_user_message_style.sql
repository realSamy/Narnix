-- Migration 0003: per-reader message formatting preference
--
-- Rich messages (Bot API 10.1+) are what ticket threads use for the conversation
-- recap. A Telegram client too old to know the type shows a placeholder instead, and
-- nothing in the Bot API reports that back: the send succeeds, no error is raised, and
-- there is no capability flag on the recipient to test beforehand. The only party who
-- can see the failure is the reader, so the escape hatch has to be theirs to pull.
--
-- Both columns follow `blocked_at`'s idiom from 0001: NULL means "has not happened",
-- a timestamp means it has. Keeping the instant rather than a 0/1 flag costs nothing
-- and answers the support question a boolean cannot ("since when has this account
-- been on simple mode?").
-- -----------------------------------------------------------------------------

-- Set when the reader asked for plain text instead of rich blocks; NULL = rich.
ALTER TABLE users
    ADD COLUMN simple_messages_at DATETIME;

-- Set when the one-time "not displaying properly?" notice was sent, so it is offered
-- once per account and never again.
ALTER TABLE users
    ADD COLUMN style_hint_at DATETIME;
