import { Env } from "../types";
import { drainBroadcast } from "./broadcast";

/**
 * Cron dispatch.
 *
 * One expression ships in `wrangler.jsonc`:
 *
 *  - `* * * * *` — the broadcast drain. It wants to run as often as possible, because its
 *                  throughput is `BATCH_SIZE` per invocation and nothing else.
 *
 * **Adding a second job.** Declare another expression under `triggers.crons` and add a
 * branch here. Two things about that are worth knowing before you do:
 *
 *  1. `event.cron` is the *literal expression string* from the config, so branches match
 *     it as text — not by clock arithmetic. A branch whose string differs from the config
 *     by one character never runs, and because the last branch is the fallback, the
 *     symptom is a silent extra broadcast drain rather than an error. Copy the string.
 *  2. Give a job its own expression rather than folding it into an existing branch. Each
 *     scheduled invocation gets its own subrequest budget (50 on the Free plan), so two
 *     jobs on two triggers never compete for it, and Cron Triggers themselves are free
 *     (5 per account). Splitting is what makes a second job affordable at all.
 *
 * A worked example of the pattern, from the bot this base was extracted from:
 *
 * ```ts
 * if (event.cron === "*\/15 * * * *") {
 *   await runExpiryWarnings(env);
 *   return;
 * }
 * ```
 */
export async function runCron(event: ScheduledController, env: Env): Promise<void> {
  try {
    // Everything reaching the fallback — the every-minute trigger, and a manual
    // `wrangler dev --test-scheduled` invocation with no matching expression — drains the
    // broadcast queue, which is a no-op when nothing is queued.
    await drainBroadcast(env);
  } catch (err) {
    // A throw here is invisible: nobody is watching the response of a scheduled
    // invocation. Logging it is the only way it reaches `wrangler tail`.
    console.error(`cron ${event.cron} failed`, err);
  }
}
