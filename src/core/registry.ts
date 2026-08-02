import { Bot } from "grammy";
import { MyContext } from "../types/context";
import { BotModule, ConversationSpec } from "./module";

import { StartModule } from "../modules/start";
import { LanguageModule } from "../modules/language";
import { AdminModule } from "../modules/admin";
import { TicketModule } from "../modules/ticket";

export class ModuleRegistry {
  private modules: Map<string, BotModule> = new Map();

  /**
   * Registration order is the order middleware runs, so it is the one thing here that
   * is not arbitrary. Two rules worth keeping when you add your own modules:
   *
   *  - **`StartModule` first.** It owns `/start`, which upserts the user row every other
   *    module reads. A module registered before it can run against a user that does not
   *    exist in D1 yet.
   *  - **`AdminModule` last.** Its composer is filtered to admins and claims broad
   *    callback patterns; registering it earlier lets it shadow a feature module's
   *    handler for anyone who happens to be an admin, which is the hardest class of bug
   *    to notice because it only reproduces on your own account.
   *
   * Add feature modules in between.
   */
  constructor() {
    this.register(StartModule);
    this.register(LanguageModule);
    this.register(TicketModule);
    this.register(AdminModule);
  }

  public register(module: BotModule): this {
    // Fail loudly on a duplicate id. Previously this was a bare `Map.set`, which
    // silently evicted the earlier module — the coupon module shipped with
    // `id: "shop"` and was overwritten by ShopModule, so every coupon admin
    // handler was unreachable with no error anywhere. A collision is always a
    // bug, so it must not be recoverable.
    const existing = this.modules.get(module.id);
    if (existing) {
      throw new Error(
        `Duplicate module id "${module.id}": ` +
          `"${module.name}" collides with already-registered "${existing.name}". ` +
          `Module ids must be unique — rename one of them.`,
      );
    }

    this.modules.set(module.id, module);
    return this;
  }

  public attachToBot(bot: Bot<MyContext>): void {
    for (const module of this.modules.values()) {
      bot.use(module.composer);
    }
  }

  /**
   * Every wizard declared by every registered module, in registration order.
   *
   * Conversation ids are checked for collisions for the same reason module ids
   * are: `ctx.conversation.enter(id)` resolves through a single flat Map, so a
   * duplicate id would silently shadow one wizard with another and the only
   * symptom would be the wrong form opening.
   */
  public getConversations(): ConversationSpec[] {
    const specs: ConversationSpec[] = [];
    const owners = new Map<string, string>();

    for (const module of this.modules.values()) {
      for (const spec of module.conversations ?? []) {
        const owner = owners.get(spec.id);
        if (owner) {
          throw new Error(
            `Duplicate conversation id "${spec.id}": declared by both ` +
              `module "${owner}" and module "${module.id}". ` +
              `Conversation ids must be unique across all modules.`,
          );
        }

        owners.set(spec.id, module.id);
        specs.push(spec);
      }
    }

    return specs;
  }

  public getModules(): BotModule[] {
    return Array.from(this.modules.values());
  }
}