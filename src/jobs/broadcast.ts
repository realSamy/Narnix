import { Api } from "grammy";
import { Env } from "../types";
import { translatorFor } from "../utils/i18n";
import { isPermanentFailure } from "./reachability";

/**
 * The broadcast drain.
 *
 * Runs on the every-minute Cron Trigger and moves one broadcast forward by a fixed
 * batch, then returns. It is deliberately *not* a loop to completion: a Worker
 * invocation on the Free plan gets 50 subrequests, and each recipient costs one, so
 * finishing a large broadcast in a single invocation is not possible at any batch size.
 *
 * A batch of 15 leaves generous headroom (the accounting below adds 3 more) and works
 * out to roughly 900 recipients an hour, which is also comfortably under Telegram's
 * ~30 messages/second bulk guidance.
 */
const BATCH_SIZE = 15;

/** Broadcast row fields the drain needs. */
interface BroadcastJob {
  id: number;
  message: string;
  parse_mode: string | null;
  created_by: number;
  cursor_user_id: number;
  sent_count: number;
  failed_count: number;
}

/**
 * Advances the oldest live broadcast by one batch. A no-op when nothing is queued.
 *
 * Subrequest budget, worst case: 1 job lookup + 1 recipient page + 15 sends +
 * 1 progress batch = 18. The completion path replaces the sends with 1 translator
 * lookup + 1 report send.
 */
export async function drainBroadcast(env: Env): Promise<void> {
  const job = await env.DB.prepare(
    `SELECT id, message, parse_mode, created_by, cursor_user_id, sent_count, failed_count
       FROM broadcasts
      WHERE status IN ('queued', 'running')
      ORDER BY id
      LIMIT 1`,
  ).first<BroadcastJob>();

  if (!job) return;

  // Keyset, not OFFSET: each batch is an index seek on `idx_users_reachable` no matter
  // how far in the job is, and a user who signs up mid-broadcast is either past the
  // cursor (and gets the message) or behind it (and does not) — never served twice.
  const { results: recipients } = await env.DB.prepare(
    `SELECT id
       FROM users
      WHERE id > ? AND blocked_at IS NULL
      ORDER BY id
      LIMIT ?`,
  )
    .bind(job.cursor_user_id, BATCH_SIZE)
    .all<{ id: number }>();

  if (!recipients || recipients.length === 0) {
    await finishBroadcast(env, job);
    return;
  }

  // A bare `Api` has none of the bot's middleware, so the default-Markdown transformer
  // in `core/parseMode.ts` is not in play here — the mode has to be passed explicitly.
  const api = new Api(env.BOT_TOKEN);
  const parseMode = job.parse_mode === "HTML" ? ("HTML" as const) : undefined;

  let sent = 0;
  let failed = 0;
  const unreachable: number[] = [];

  for (const recipient of recipients) {
    try {
      await api.sendMessage(recipient.id, job.message, {
        parse_mode: parseMode,
        link_preview_options: { is_disabled: true },
      });
      sent++;
    } catch (err) {
      failed++;
      if (isPermanentFailure(err)) unreachable.push(recipient.id);
      else console.error(`broadcast ${job.id}: send to ${recipient.id} failed`, err);
    }
  }

  // The cursor advances past failures too. Retrying them would be defensible, but a
  // user whose send fails every time would otherwise hold the cursor still and block
  // the queue for every remaining recipient, forever.
  const lastId = recipients[recipients.length - 1].id;

  const statements = [
    env.DB.prepare(
      `UPDATE broadcasts
          SET status         = 'running',
              cursor_user_id = ?,
              sent_count     = sent_count + ?,
              failed_count   = failed_count + ?
        WHERE id = ?`,
    ).bind(lastId, sent, failed, job.id),
  ];

  if (unreachable.length > 0) {
    const holes = unreachable.map(() => "?").join(", ");
    statements.push(
      env.DB.prepare(
        `UPDATE users SET blocked_at = datetime('now') WHERE id IN (${holes})`,
      ).bind(...unreachable),
    );
  }

  // One subrequest for both statements.
  await env.DB.batch(statements);
}

/** Closes the job out and reports the tally to whoever started it. */
async function finishBroadcast(env: Env, job: BroadcastJob): Promise<void> {
  const closed = await env.DB.prepare(
    `UPDATE broadcasts
        SET status = 'done', finished_at = datetime('now')
      WHERE id = ? AND status IN ('queued', 'running')`,
  )
    .bind(job.id)
    .run();

  // Two cron invocations can overlap on a slow batch. Claiming the row by predicate
  // means only one of them sends the report; D1 returns `success: true` either way, so
  // `meta.changes` is the test.
  if (!closed.success || closed.meta.changes === 0) return;

  try {
    const _ = await translatorFor(env.DB, job.created_by);
    const api = new Api(env.BOT_TOKEN);

    await api.sendMessage(
      job.created_by,
      _("admin.broadcast.finished", {
        id: String(job.id),
        sent: String(job.sent_count),
        failed: String(job.failed_count),
      }),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    console.error(`broadcast ${job.id}: could not report completion`, err);
  }
}
