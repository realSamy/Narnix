import { Bot, NextFunction } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";

import { MyContext, MyConversationContext } from "../types/context";
import { Env } from "../types";
import { ConversationSpec } from "./module";
import { d1ConversationStorage } from "./conversationStorage";
import { defaultParseMode } from "./parseMode";
import { getTranslator } from "../utils/i18n";

/**
 * How long a wizard may sit idle before it gives up on the user.
 *
 * Without a limit an abandoned form is immortal: the next thing that person types
 * — days later, about something unrelated — gets swallowed as an answer to a
 * question they have long forgotten. On timeout the plugin halts the conversation
 * with `next: true`, so the late update flows on to the normal handlers as if no
 * wizard had ever been open.
 */
const WIZARD_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Installs the conversations plugin and mounts every module's wizards.
 *
 * Must run *before* the module composers are attached: while a wizard is active
 * it consumes the update, and if a module's `on("message:text")` handler were
 * mounted first it would swallow the user's answer instead.
 *
 * ## Why each wizard is mounted inside a wrapper middleware
 *
 * Conversations build their context objects from scratch on every replay, so
 * `ctx.env` and `ctx._` — which the outside middleware in `core/bot.ts` attaches —
 * do not exist inside a wizard. They are re-attached via the `plugins` option.
 *
 * `env` comes from the closure (a Worker calls `createBot` per request, so it is
 * always the current request's bindings). The *language* is the interesting part:
 * it lives in `ctx.session`, which conversations cannot see.
 *
 * Reading it with `conversation.external()` inside a `plugins` factory would work
 * — but the factory is invoked once per consumed update, from inside `wait()`
 * (`conversation.js`: `const middleware = await this.plugins(this)`), so a lookup
 * there would repeat for every step of every wizard and add an entry to the replay
 * log each time.
 *
 * Mounting each wizard behind a thin wrapper instead means the language is read
 * once, in the *outside* tree where the session is still available, and captured
 * in a plain closure. The `plugins` array is then static data with no replay
 * interaction at all. Building the middleware per update costs a few closures.
 */
export function installConversations(
  bot: Bot<MyContext>,
  env: Env,
  specs: ConversationSpec[],
): void {
  // NOTE: this middleware reads the conversation store on *every* update, not just
  // updates that involve a wizard (`plugin.js`: `const state = await
  // storage.read() ?? {}` runs unconditionally). That is one extra D1 lookup per
  // update, by primary key. Writes are conditional and only happen when a
  // conversation is actually entered or advanced.
  bot.use(
    conversations<MyContext, MyConversationContext>({
      storage: d1ConversationStorage(env.DB),
    }),
  );

  for (const spec of specs) {
    bot.use(async (ctx, next) => {
      const lang = ctx.session?.lang || "fa";

      const middleware = createConversation<MyContext, MyConversationContext>(
        spec.builder,
        {
          id: spec.id,
          maxMillisecondsToWait: WIZARD_IDLE_TIMEOUT_MS,
          plugins: [
            async (
              conversationCtx: MyConversationContext,
              conversationNext: NextFunction,
            ) => {
              conversationCtx.env = env;
              conversationCtx._ = getTranslator(lang);
              conversationCtx.api.config.use(defaultParseMode);
              await conversationNext();
            },
          ],
        },
      );

      return middleware(ctx, next);
    });
  }
}
