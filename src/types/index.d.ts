export interface Env {
  // Cloudflare D1 Database binding
  DB: D1Database;
  // Cloudflare KV Namespace binding (grammY session storage)
  SESSION_KV: KVNamespace;
  // Bot Token
  BOT_TOKEN: string;

  /**
   * Optional channel-membership gate. `CHANNEL_LOCK` is a `@username` or numeric id;
   * `CHANNEL_LOCK_LINK` is the invite URL shown to a user who is not a member. Leave
   * `CHANNEL_LOCK` empty to disable the gate — see `src/middlewares/channelLock.ts`.
   */
  CHANNEL_LOCK: string;
  CHANNEL_LOCK_LINK: string;

  /**
   * Numeric Telegram id of the bot owner. Always an admin, cannot be removed from the
   * admins screen, and is the only account that exists before the first migration runs.
   */
  OWNER: string;

  /**
   * Optional SOCKS proxy URL, read only by `src/poll.ts` for local long-polling
   * development. Never set in production — the deployed Worker reaches Telegram
   * directly. Declared here because `getPlatformProxy()` surfaces `.dev.vars`
   * through this same type.
   */
  LOCAL_PROXY?: string;
}
