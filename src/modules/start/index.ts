import {Composer} from "grammy";
import {MyContext} from "../../types/context";
import {BotModule} from "../../core/module";
import {showMainMenu} from "./utils";
import {membershipAllows, verifyMembership} from "../../middlewares/channelLock";

const startComposer = new Composer<MyContext>();


// --- Commands & Handlers ---
startComposer.command(["start", "menu", "cancel"], async (ctx) => {
  ctx.session.step = "idle";

  await showMainMenu(ctx, false);
});

// Return to main menu callback handler (used by Cancel/Back buttons across all plugins)
startComposer.callbackQuery("action_cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await showMainMenu(ctx, true);
});

/**
 * "I joined" — the one button the channel lock lets through.
 *
 * The re-check used to swallow its own errors and fall straight through to the
 * welcome, so any hiccup at Telegram *granted* access on the strength of the user's
 * own claim. It now shares `verifyMembership` and the single fail-open/fail-closed
 * policy with the middleware, which is the only way the two can agree: whatever the
 * middleware would do with an unavailable check, this button does too.
 *
 * A confirmed non-member gets `alert.member_not_verified` — an answer to what they
 * just asserted — rather than the middleware's "you must join {channel}", which they
 * have already read.
 */
startComposer.callbackQuery("start_joined", async (ctx) => {
  const result = await verifyMembership(ctx);

  if (!membershipAllows(result)) {
    await ctx.answerCallbackQuery({
      text: result === "not_member"
        ? ctx._("alert.member_not_verified")
        : ctx._("not_channel_member_alert", { link: ctx.env.CHANNEL_LOCK_LINK ?? "" }),
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: "✅ " + ctx._("welcome_alert") });

  await showMainMenu(ctx, true);
});


export const StartModule: BotModule = {
  id: "start",
  name: "Start Command & Navigation Dashboard",
  composer: startComposer,
};