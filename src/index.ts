import { webhookCallback } from "grammy";
import { createBot } from "./core/bot";
import { assertEnv } from "./core/env";
import { runCron } from "./jobs";
import { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Narnix Bot Worker Online", { status: 200 });
    }

    assertEnv(env);

    const bot = createBot(env.BOT_TOKEN, env);
    return webhookCallback(bot, "cloudflare-mod")(request);
  },

  /**
   * Cron Triggers. See `src/jobs/index.ts` for which expression does what.
   *
   * `runCron` swallows its own errors, so nothing here needs a try/catch; it is
   * awaited rather than handed to `waitUntil` because a scheduled invocation's
   * lifetime is already the whole handler.
   */
  async scheduled(event: ScheduledController, env: Env, executionCtx: ExecutionContext): Promise<void> {
    assertEnv(env);
    await runCron(event, env);
  },
};
