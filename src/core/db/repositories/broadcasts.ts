// =============================================================================
// Data handlers for the `broadcasts` queue.
//
// The queue's contract is what makes broadcasts possible on a Worker: the
// wizard writes ONE row and stops, and the every-minute cron moves the oldest
// live row forward by one batch (see `src/jobs/broadcast.ts`). Everything a
// caller needs to keep that contract — the live-status filter, the keyset
// cursor, the completion claim — is a function in this file, so the drain job
// reads as orchestration and not as SQL.
// =============================================================================

import { D1Database } from "@cloudflare/workers-types";
import { Broadcast } from "../../../types/database";
import { repo } from "../model";
import { Broadcasts } from "../models";
import { stampBlockedStatement } from "./users";

/** The live statuses a drain picks up, in the order it picks them up. */
const LIVE_STATUSES = ["queued", "running"] as const;

/** The oldest broadcast that still has work, or null when the queue is empty. */
export async function findOldestLive(db: D1Database): Promise<Broadcast | null> {
  const rows = await repo(db, Broadcasts).all(
    { status: [...LIVE_STATUSES] },
    { orderBy: ["id"], limit: 1 },
  );

  return rows[0] ?? null;
}

/**
 * Whether any broadcast is queued or running.
 *
 * The broadcast wizard asks this before composing: a second live job would
 * interleave with the first (the drain takes the oldest row), so the newer one
 * would sit queued behind it for however long the first takes — long enough
 * that the author would reasonably assume it was lost.
 */
export async function hasLiveBroadcast(db: D1Database): Promise<boolean> {
  return (await repo(db, Broadcasts).count({ status: [...LIVE_STATUSES] })) > 0;
}

/**
 * Queues a broadcast. Returns its job id, or null if the insert failed.
 *
 * `parse_mode` is whatever the wizard validated against Telegram — the queue
 * stores the mode, not the trust: a body that failed the author's preview
 * never gets a row in the first place.
 */
export async function createBroadcast(
  db: D1Database,
  input: { message: string; parseMode: "HTML" | null; createdBy: number },
): Promise<number | null> {
  const row = await repo(db, Broadcasts).insertReturning<{ id: number }>({
    message: input.message,
    parse_mode: input.parseMode,
    created_by: input.createdBy,
    status: "queued",
  });

  return row?.id ?? null;
}

/**
 * Claims the right to drain one job's next batch.
 *
 * Two cron invocations can overlap — a slow batch, a platform retry — and
 * without a claim both would SELECT the same job and cursor page and deliver
 * the whole batch twice. The claim is a conditional UPDATE: it succeeds only if
 * the job is live *and* unclaimed (or its lease has expired), so exactly one
 * invocation's `meta.changes` is 1. The lease is just under the cron interval:
 * a claim lost to a crashed invocation costs one minute of queue idleness,
 * while an unbounded claim would stall the queue on the first crash.
 */
export async function claimBatch(db: D1Database, jobId: number): Promise<boolean> {
  const claimed = await db
    .prepare(
      `UPDATE broadcasts
          SET status     = 'running',
              lease_until = datetime('now', '+55 seconds')
        WHERE id = ?
          AND status IN ('queued', 'running')
          AND (lease_until IS NULL OR lease_until < datetime('now'))`,
    )
    .bind(jobId)
    .run();

  return claimed.success && claimed.meta.changes > 0;
}

/**
 * Advances one broadcast past the batch it just attempted.
 *
 * `unreachableIds` — users Telegram reported as permanently gone — are stamped
 * `blocked_at` in the same D1 batch, so the whole batch costs one subrequest
 * and future drains skip them from the first query.
 *
 * The cursor advances past failures too. Retrying them would be defensible,
 * but a user whose send fails every time would otherwise hold the cursor
 * still and block the queue for every remaining recipient, forever.
 */
export async function advanceBroadcast(
  db: D1Database,
  advance: {
    jobId: number;
    cursorUserId: number;
    sent: number;
    failed: number;
    unreachableIds: number[];
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE broadcasts
            SET status         = 'running',
                cursor_user_id = ?,
                sent_count     = sent_count + ?,
                failed_count   = failed_count + ?,
                lease_until    = NULL
          WHERE id = ?`,
      )
      .bind(advance.cursorUserId, advance.sent, advance.failed, advance.jobId),
  ];

  if (advance.unreachableIds.length > 0) {
    statements.push(stampBlockedStatement(db, advance.unreachableIds));
  }

  // One subrequest for both statements.
  await db.batch(statements);
}

/**
 * Closes a broadcast out — if this invocation is the one that gets to.
 *
 * Two cron invocations can overlap on a slow batch. Claiming the row by
 * predicate means only one of them wins the UPDATE and sends the report; D1
 * returns `success: true` either way, so `meta.changes` is the test.
 */
export async function claimFinished(db: D1Database, jobId: number): Promise<boolean> {
  const closed = await db
    .prepare(
      `UPDATE broadcasts
          SET status = 'done', finished_at = datetime('now'), lease_until = NULL
        WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .bind(jobId)
    .run();

  return closed.success && closed.meta.changes > 0;
}
