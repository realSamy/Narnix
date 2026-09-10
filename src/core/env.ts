import { Env } from "../types";

/**
 * Startup validation for the variables that are no longer in `wrangler.jsonc`.
 *
 * Moving OWNER / CHANNEL_LOCK out of committed `vars` and into
 * secrets removes them from source control, and introduces one new failure mode: a
 * deploy where a `wrangler secret put` was forgotten. Nothing throws in that case —
 * `env.OWNER` is simply `undefined`, `isAdmin` returns false for every human alive,
 * and the bot looks like it works while being unadministrable.
 *
 * So the check is explicit and loud, and it is a *log*, not a throw: a bot that keeps
 * serving customers with a broken channel lock is better than one that 500s on every
 * update. Bindings (DB, SESSION_KV) are not checked here — a missing binding is a
 * deploy-time error in Cloudflare's own config, and it fails loudly on first use.
 */

/** Variables without which the bot cannot function correctly. */
const REQUIRED = ["BOT_TOKEN", "OWNER"] as const;

/**
 * Variables whose absence disables a feature rather than breaking the bot.
 *
 * `CHANNEL_LOCK` unset means the lock is off, which is a legitimate configuration —
 * `channelLock.ts` already treats it that way. It is listed so that "the lock stopped
 * working" is diagnosable from the log instead of by reading middleware.
 */
const OPTIONAL = ["CHANNEL_LOCK", "CHANNEL_LOCK_LINK", "WEBHOOK_SECRET"] as const;

function missing(env: Env, names: readonly string[]): string[] {
  return names.filter((name) => {
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

/**
 * Logs any absent configuration. Called once per invocation from both entry points;
 * the cost is two array scans, and Workers give no cheaper "once per isolate" hook
 * that survives the way a module-level flag does not across cold starts.
 */
export function assertEnv(env: Env): void {
  const required = missing(env, REQUIRED);
  const optional = missing(env, OPTIONAL);

  if (required.length > 0) {
    console.error(
      `env: missing required ${required.join(", ")} — set with \`wrangler secret put <NAME>\`` +
        " (or in .dev.vars locally). The bot will misbehave until they exist.",
    );
  }

  if (optional.length > 0) {
    console.warn(`env: ${optional.join(", ")} unset — the features they drive are disabled.`);
  }
}
