import {MyContext} from "../../types/context";
import {InlineKeyboard} from "grammy";

export async function loadAdminUsers(ctx: MyContext) {
  const adminIds = await getAdminIds(ctx);

  const keyboard = new InlineKeyboard();
  adminIds.forEach((id) => {
    const isOwner = id === ctx.env.OWNER;
    const label = isOwner
      ? ctx._('admin.admins.owner_entry', { id })
      : ctx._('admin.admins.entry', { id });

    if (!isOwner) {
      keyboard.text(label, "ignore").text(ctx._('common.delete'), `admin_del:${id}`).row();
    } else {
      keyboard.text(label, "ignore").row();
    }
  });

  keyboard.text(ctx._('admin.admins.add_button'), "admin_add_start").row();
  keyboard.text(ctx._('common.back'), "admin_main");
  return keyboard;
}

/**
 * The admin dashboard's keyboard — the base's three screens.
 *
 * Add your own rows *below* these. Keeping people-facing tools (lookup, broadcast) at the
 * top is a deliberate habit from the bot this was extracted from, where every admin screen
 * was about inventory and none about the users buying it; that is an easy shape to fall
 * back into once you start adding features.
 */
export function generateAdminMainKeyboard(ctx: MyContext) {
  return new InlineKeyboard()
    .text(ctx._('admin.lookup.button'), "admin_user_lookup")
    .text(ctx._('admin.broadcast.button'), "admin_broadcast").row()
    .text(ctx._('admin.manage_admins'), "admin_manage_users").row();
}

export async function showAdminDashboard(ctx: MyContext) {
  const keyboard = generateAdminMainKeyboard(ctx);
  const text = ctx._('admin.management_panel');

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
      parse_mode: "Markdown",
    });
  } else {
    await ctx.reply(text, {
      reply_markup: keyboard,
      parse_mode: "Markdown",
    });
  }
}

/**
 * Checks whether the current user is the Bot Owner or listed in D1 admins table
 */
export async function isAdmin(ctx: MyContext): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  // The main Bot Owner defined in env is always super-admin
  if (ctx.env.OWNER && userId.toString() === ctx.env.OWNER) {
    return true;
  }

  // Query D1 database for admin record
  const admin = await ctx.env.DB.prepare(
    "SELECT user_id FROM admins WHERE user_id = ?"
  )
    .bind(userId)
    .first();

  return !!admin;
}

/**
 * Fetches all admin User IDs from D1 (including Bot Owner)
 */
export async function getAdminIds(ctx: MyContext): Promise<string[]> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT user_id FROM admins"
  ).all();

  const adminIds = results.map((row: any) => row.user_id.toString());

  // Ensure Owner ID is included
  if (ctx.env.OWNER && !adminIds.includes(ctx.env.OWNER)) {
    adminIds.push(ctx.env.OWNER);
  }

  return adminIds;
}

/**
 * Remove an admin from D1 database
 */
export async function removeAdmin(ctx: MyContext, targetUserId: number): Promise<boolean> {
  try {
    await ctx.env.DB.prepare("DELETE FROM admins WHERE user_id = ?")
      .bind(targetUserId)
      .run();
    return true;
  } catch (err) {
    console.error("Failed to remove admin:", err);
    return false;
  }
}
