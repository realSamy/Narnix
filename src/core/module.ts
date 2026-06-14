import { Composer } from "grammy";
import type { ConversationBuilder } from "@grammyjs/conversations";
import { MyContext, MyConversation, MyConversationContext } from "../types/context";

/**
 * A wizard owned by a module.
 *
 * `id` is what handlers pass to `ctx.conversation.enter(id)`. It is declared
 * explicitly rather than inferred from the function name, because bundlers are
 * free to rename functions and an id that changes under minification would strand
 * every in-flight conversation.
 */
export interface ConversationSpec {
  id: string;
  builder: ConversationBuilder<MyContext, MyConversationContext>;
}

export interface BotModule {
  /** Unique plugin identifier (e.g. 'wallet', 'shop'). Must be unique — the
   *  registry throws on a collision. */
  id: string;
  name: string;
  description?: string;

  /** The grammY Composer instance containing the module's routes and handlers */
  composer: Composer<MyContext>;

  /**
   * Multi-step form flows this module owns. The registry mounts every module's
   * conversations ahead of every module's composer, so an active wizard consumes
   * the update before any `message:text` handler can steal it.
   */
  conversations?: ConversationSpec[];
}

/** Convenience alias so wizard files can annotate their own signature. */
export type WizardBuilder = (
  conversation: MyConversation,
  ctx: MyConversationContext,
  ...args: any[]
) => Promise<void>;

// NOTE: an `onInit?: (env) => ...` lifecycle hook used to be declared here. It
// was never called by the registry and never implemented by any module, and a
// per-request Worker has no startup phase to call it from. The pattern that
// actually works in this codebase is lazy self-healing on first use — see
// GatewayRegistry.getActiveGateways(), which calls syncWithDB() before reading.
// Do the same rather than reintroducing a startup hook.
