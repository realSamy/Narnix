import { GrammyError } from "grammy";

/**
 * Whether a send failure means "this chat cannot be reached, ever".
 *
 * 403 is the user having blocked the bot. 400 "chat not found" is an account that was
 * deleted, or one that never started the bot at all — a `users` row can exist without a
 * live chat if it was created by a referral. Both are permanent, so the user is stamped
 * `blocked_at` and skipped by every future job; anything else (a 429, a 500, a network
 * blip) is transient and must not be, or one bad minute would permanently silence a
 * paying customer.
 */
export function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  if (err.error_code === 403) return true;

  return err.error_code === 400 && /chat not found|user is deactivated/i.test(err.description);
}
