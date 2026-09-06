import { describe, expect, it } from "vitest";
import { GrammyError, HttpError } from "grammy";

import { isPermanentFailure } from "./reachability";

/**
 * `isPermanentFailure` is the reachability policy in one function: a wrong
 * classification either silences a customer forever (a transient failure
 * stamped `blocked_at`) or burns the broadcast's rate limit on sends that can
 * never land (a permanent failure retried). Both halves are worth pinning.
 */
function telegramError(code: number, description: string): GrammyError {
  // The same shape Telegram's own 400/403 bodies arrive in; grammY only reads
  // `error_code` and `description` off it.
  return new GrammyError(
    "Bad Request",
    { ok: false, error_code: code, description },
    "sendMessage",
    // payload: grammY's ctor takes it, and `isPermanentFailure` only reads
    // `error_code` and `description` off the result.
    {},
  );
}

describe("isPermanentFailure", () => {
  it("treats 403 (bot was blocked) as permanent", () => {
    expect(isPermanentFailure(telegramError(403, "Forbidden: bot was blocked by the user"))).toBe(true);
  });

  it("treats 'chat not found' as permanent — an account deleted or never started", () => {
    expect(isPermanentFailure(telegramError(400, "Bad Request: chat not found"))).toBe(true);
  });

  it("treats a deactivated account as permanent", () => {
    expect(isPermanentFailure(telegramError(400, "Bad Request: user is deactivated"))).toBe(true);
  });

  it("treats every other 400 as transient", () => {
    // A 400 that is *not* a reachability fact (bad markup, say) must not stamp
    // a user out of every future broadcast.
    expect(isPermanentFailure(telegramError(400, "Bad Request: message text is empty"))).toBe(false);
  });

  it("treats 429 and 5xx as transient — one bad minute must not silence a customer", () => {
    expect(isPermanentFailure(telegramError(429, "Too Many Requests: retry after 5"))).toBe(false);
    expect(isPermanentFailure(telegramError(500, "Internal Server Error"))).toBe(false);
  });

  it("ignores errors that did not come from Telegram", () => {
    expect(isPermanentFailure(new Error("D1: no such table"))).toBe(false);
    expect(isPermanentFailure(new HttpError("network down", new Error("ECONNRESET")))).toBe(false);
    expect(isPermanentFailure(undefined)).toBe(false);
  });
});
