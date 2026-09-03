import { Api } from "grammy";
import { Env } from "../types";
import { Broadcast } from "../types/database";
import { translatorFor } from "../utils/i18n";
import { isPermanentFailure } from "./reachability";
import {
  advanceBroadcast,
  claimFinished,
  findOldestLive,
} from "../core/db/repositories/broadcasts";
import { listReachableIdsAfter } from "../core/db/repositories/users";

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
 *
 * All queue mechanics — the live-status filter, the keyset cursor, the completion
 * claim, the unreachable stamp — live in `core/db/repositories/broadcasts.ts`.
 * This file is only the send loop and its error classification.
 */
const BATCH_SIZE = 15;

/**
 * Advances the oldest live broadcast by one batch. A no-op when nothing is queued.
 *
 * Subrequest budget, worst case: 1 job lookup + 1 recipient page + 15 sends +
 * 1 progress batch = 18. The completion path replaces the sends with 1 translator
 * lookup + 1 report send.
 */
export async function drainBroadcast(env: Env): Promise<void> {
  const job = await findOldestLive(env.DB);

  if (!job) return;

  // Keyset, not OFFSET: each batch is an index seek on `idx_users_reachable` no matter
  // how far in the job is, and a user who signs up mid-broadcast is either past the
  // cursor (and gets the message) or behind it (and does not) — never served twice.
  const recipients = await listReachableIdsAfter(env.DB, job.cursor_user_id, BATCH_SIZE);

  if (recipients.length === 0) {
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
      await api.sendMessage(recipient, job.message, {
        parse_mode: parseMode,
        link_preview_options: { is_disabled: true },
      });
      sent++;
    } catch (err) {
      failed++;
      if (isPermanentFailure(err)) unreachable.push(recipient);
      else console.error(`broadcast ${job.id}: send to ${recipient} failed`, err);
    }
  }

  await advanceBroadcast(env.DB, {
    jobId: job.id,
    cursorUserId: recipients[recipients.length - 1],
    sent,
    failed,
    unreachableIds: unreachable,
  });
}

/** Closes the job out and reports the tally to whoever started it. */
async function finishBroadcast(env: Env, job: Broadcast): Promise<void> {
  // The predicate claim decides which of two overlapping cron invocations
  // gets to report; the loser returns here.
  if (!(await claimFinished(env.DB, job.id))) return;

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
