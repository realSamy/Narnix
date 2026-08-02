import { Bot, BotConfig, session } from "grammy";
import { MyContext, SessionData } from "../types/context";
import { Env } from "../types";
import { ModuleRegistry } from "./registry";
import { installConversations } from "./conversations";
import { defaultParseMode } from "./parseMode";
import { getTranslator, getUserLanguage, normalizeLanguage } from "../utils/i18n";
import { kvStorage } from "../utils/kvStorage";
import errorHandler from "./errorHandler";
import { channelLockMiddleware } from "../middlewares/channelLock";

/**
 * Resolves the language for this update and caches it on the session.
 *
 * The session used to be initialised with a hardcoded `lang: "fa"` while
 * `ensureUser` wrote `users.lang` from `from.language_code`. Nothing reconciled
 * the two, so an English-client user read Persian on their own screens and
 * received English in every notice built with `translatorFor` — and a deliberate
 * switch would have been invisible to half the bot.
 *
 * Precedence: the stored preference, then the Telegram client language, then
 * Persian. The database read happens once per session (24h), not per update.
 */
async function resolveLanguage(ctx: MyContext): Promise<void> {
  if (!ctx.session.lang) {
    const userId = ctx.from?.id;

    // A user with no row yet is mid-`/start`; `language_code` is the only signal
    // available, and `ensureUser` is about to persist the same derivation.
    const stored = userId ? await getUserLanguage(ctx.env.DB, userId).catch(() => null) : null;

    ctx.session.lang = stored ?? normalizeLanguage(ctx.from?.language_code);
  }

  ctx._ = getTranslator(ctx.session.lang);
}

/**
 * Builds the bot for a single request.
 *
 * Middleware order matters here and is deliberate:
 *
 *  1. `session` — everything downstream reads `ctx.session`.
 *  2. env + i18n binder — `ctx.env` / `ctx._`, needed by the channel lock.
 *  3. `channelLock` — runs before wizards so a locked-out user mid-form still
 *     gets the join prompt instead of the wizard eating the message.
 *  4. `installConversations` — mounts the conversations plugin (which is what
 *     gives module handlers `ctx.conversation.enter(...)`) and then every
 *     module's wizards. Must precede the module composers: while a wizard is
 *     active it consumes the update, and a module's `on("message:text")`
 *     handler mounted first would swallow the answer instead.
 *  5. module composers.
 */
export function createBot(token: string, env: Env, config?: BotConfig<MyContext>) {
  const bot = new Bot<MyContext>(token, config);

  const sessionStorageAdapter = env?.SESSION_KV
    ? kvStorage<SessionData>(env.SESSION_KV, 86400) // 24-hour session TTL
    : undefined;               // In-memory fallback for vitest tests

  // In-memory or KV-backed Session Middleware
  bot.use(
    session<SessionData, MyContext>({
      // `lang` is deliberately absent: it is hydrated from D1 by `resolveLanguage`
      // below, and seeding it here would make every new session claim Persian.
      initial: () => ({ step: "idle" }),
      storage: sessionStorageAdapter,
    }),
  );

  // Native API Transformer to set default parse_mode
  bot.api.config.use(defaultParseMode);

  // Bind environment context and i18n translator
  bot.use(async (ctx, next) => {
    ctx.env = env;
    await resolveLanguage(ctx);
    await next();
  });

  // Channel lock logic
  bot.use(channelLockMiddleware);

  bot.catch(errorHandler);

  const registry = new ModuleRegistry();

  // Multi-step forms, mounted ahead of the handlers they belong to
  installConversations(bot, env, registry.getConversations());

  // Decorative buttons.
  //
  // Several admin lists render a label as a button because an inline keyboard is
  // the only way to lay out rows — `🟢 OFF50 (15%)` is a caption, not a control.
  // Those carry `noop` (older screens: `ignore`) as their callback data, and
  // nothing was listening: Telegram shows a spinner on the tapped button and only
  // clears it when the callback query expires, so a stray tap looked like the bot
  // had hung. Answering with no text dismisses it silently.
  bot.callbackQuery(["noop", "ignore"], (ctx) => ctx.answerCallbackQuery());

  // Attach all pluggable modules
  registry.attachToBot(bot);

  return bot;
}
