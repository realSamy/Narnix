import { getPlatformProxy } from "wrangler";
import { BotConfig } from "grammy";
import {SocksProxyAgent} from "socks-proxy-agent";

import { createBot } from "./core/bot";
import { assertEnv } from "./core/env";
import { MyContext } from "./types/context";
import { Env } from "./types";

async function main() {
  console.log("⚡ Initializing Cloudflare D1 & KV local bindings...");
  const { env } = await getPlatformProxy();

  const proxyUrl = (env.LOCAL_PROXY as string | undefined);
  let botConfig: BotConfig<MyContext> | undefined = undefined;

  if (proxyUrl) {
    console.log(`🌐 Official grammY proxy active: ${proxyUrl}`);

    // grammY's official proxy agent configuration
    botConfig = {
      client: {
        baseFetchConfig: {
          agent: new SocksProxyAgent(proxyUrl),
        },
      },
    };
  }

  const token = env.BOT_TOKEN as string;
  if (!token) {
    throw new Error("❌ BOT_TOKEN is missing in .dev.vars!");
  }

  // `getPlatformProxy()` returns bindings as `Record<string, unknown>` — it has no
  // way to know our `Env` shape, so the cast is unavoidable here. It is safe in the
  // sense that a missing binding fails loudly on first use rather than silently.
  const localEnv = env as unknown as Env;

  // Local dev is where a missing variable is most likely and least visible: since the
  // deployment ids moved out of `wrangler.jsonc`, `.dev.vars` is their only source
  // here. Without this, a forgotten OWNER shows up as "the admin panel says I'm not
  // an admin" half an hour later.
  assertEnv(localEnv);

  const bot = createBot(token, localEnv, botConfig);

  console.info("\x1b[34m🌐 Connecting to Telegram...\x1b[0m");
  await bot.start({
    onStart: () => console.info("\x1b[32m🚀 Narnix Bot is running in Long Polling mode...\x1b[0m"),
    drop_pending_updates: true,
  });
}

main().catch((err) => {
  console.error("❌ Long polling runner error:", err);
  process.exit(1);
});