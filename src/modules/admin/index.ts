import { Composer } from "grammy";
import { MyContext } from "../../types/context";
import { BotModule } from "../../core/module";
import { isAdmin, removeAdmin, showAdminDashboard, loadAdminUsers } from "./utils";
import { ADMIN_ADD_CONVERSATION, adminAddConversation } from "./wizards/admins";
import {
  USER_ADJUST_CONVERSATION,
  USER_LOOKUP_CONVERSATION,
  userAdjustConversation,
  userLookupConversation,
} from "./wizards/lookup";
import { showUserCard } from "./lookup";
import { BROADCAST_CONVERSATION, broadcastConversation } from "./wizards/broadcast";

const composer = new Composer<MyContext>();

/**
 * Everything below is behind `isAdmin`, so no individual handler re-checks permission.
 *
 * `composer.filter` is the one place that guard exists — a handler added to `composer`
 * instead of `adminComposer` is public, and nothing will tell you. When you add an admin
 * screen, add it to `adminComposer`.
 */
const adminComposer = composer.filter(isAdmin);

// --- Admin Main Dashboard ---
adminComposer.command("admin", showAdminDashboard);
adminComposer.callbackQuery("admin_main", showAdminDashboard);

// --- Dynamic Admin Management UI ---
adminComposer.callbackQuery("admin_manage_users", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = await loadAdminUsers(ctx);

  await ctx.editMessageText(ctx._('admin.admins.title'), {
    reply_markup: keyboard,
    parse_mode: "Markdown",
  });
});

adminComposer.callbackQuery("admin_add_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter(ADMIN_ADD_CONVERSATION);
});

// Remove Admin Action
adminComposer.callbackQuery(/^admin_del:(\d+)$/, async (ctx) => {
  const targetId = parseInt(ctx.match[1], 10);

  // The owner comes from `env.OWNER`, not from the `admins` table, so deleting the row
  // would not actually revoke anything — it would just make the list lie.
  if (targetId.toString() === ctx.env.OWNER) {
    await ctx.answerCallbackQuery({ text: ctx._('admin.admins.owner_undeletable') });
    return;
  }

  await removeAdmin(ctx, targetId);
  await ctx.answerCallbackQuery({ text: ctx._('admin.admins.removed') });

  // Refresh admin list
  const keyboard = await loadAdminUsers(ctx);

  await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
});

// ============================================================================
// 🔍 USER LOOKUP
//
// The owner's window onto one user: who they are, whether the bot can still reach them,
// and one lever (a balance adjustment). `admin_user_view` is the refresh button on the
// card itself, so it edits in place; the wizard's own render sends a fresh message,
// because by then the card is several messages up the chat.
// ============================================================================

adminComposer.callbackQuery("admin_user_lookup", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter(USER_LOOKUP_CONVERSATION);
});

adminComposer.callbackQuery(/^admin_user_view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showUserCard(ctx, parseInt(ctx.match[1], 10));
});

adminComposer.callbackQuery(/^admin_user_adjust:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter(USER_ADJUST_CONVERSATION, parseInt(ctx.match[1], 10));
});

// ============================================================================
// 📣 BROADCAST
//
// The wizard only *queues* the message; `src/jobs/broadcast.ts` delivers it in
// batches off the every-minute cron. A send loop here would die on the Free plan's
// 50-subrequest cap partway through, with no record of where it stopped.
// ============================================================================

adminComposer.callbackQuery("admin_broadcast", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter(BROADCAST_CONVERSATION);
});

export const AdminModule: BotModule = {
  id: "admin",
  name: "Admin Control Panel",
  composer,
  conversations: [
    adminAddConversation,
    userLookupConversation,
    userAdjustConversation,
    broadcastConversation,
  ],
};
