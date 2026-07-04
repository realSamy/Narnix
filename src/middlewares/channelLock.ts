import { InlineKeyboard, NextFunction } from "grammy";
import { MyContext } from "../types/context";
import { esc } from "../core/wizard";

/**
 * Chat member statuses that count as "in the channel".
 *
 * `restricted` is included deliberately: a muted member is still a member, and the
 * lock exists to grow the channel, not to police it. `left` and `kicked` are the
 * two that fail. This list used to be copy-pasted here and in
 * `modules/start/index.ts`, which is a silent-divergence waiting to happen.
 */
const MEMBER_STATUSES = ["creator", "administrator", "member", "restricted"] as const;

/**
 * What happens when Telegram cannot tell us whether the user is a member.
 *
 * `"allow"` — fail open. A blip at Telegram, a channel that was renamed, a bot that
 * lost its admin rights in the channel: none of those should take the shop offline
 * for every customer at once. The cost is that a non-member slips through while the
 * check is broken, which is a marketing loss, not a security one — nothing behind
 * this lock is confidential, and money still needs a real balance.
 *
 * `"deny"` — fail closed. Correct only if the channel lock is a licensing gate
 * rather than a growth tool. Flipping this constant is the whole change; both the
 * middleware and the "I joined" button read it.
 */
const ON_CHECK_FAILURE: "allow" | "deny" = "allow";

export type MembershipResult = "member" | "not_member" | "unavailable";

/**
 * Asks Telegram whether the user is in the locked channel.
 *
 * Returns `"unavailable"` rather than throwing or guessing, so each caller can
 * apply the policy above explicitly instead of inheriting a `catch` written for a
 * different purpose.
 */
export async function verifyMembership(ctx: MyContext): Promise<MembershipResult> {
  const channelId = ctx.env.CHANNEL_LOCK;
  const userId = ctx.from?.id;

  if (!channelId || !userId) return "member";

  try {
    const member = await ctx.api.getChatMember(channelId, userId);
    return (MEMBER_STATUSES as readonly string[]).includes(member.status)
      ? "member"
      : "not_member";
  } catch (error) {
    // Logged at error level on purpose: a persistently unavailable check means the
    // lock is silently off, and the only place that shows up is here.
    console.error("⚠️ Failed to check channel membership:", error);
    return "unavailable";
  }
}

/** Applies `ON_CHECK_FAILURE` to a membership result. */
export function membershipAllows(result: MembershipResult): boolean {
  if (result === "member") return true;
  if (result === "not_member") return false;
  return ON_CHECK_FAILURE === "allow";
}

/** `https://t.me/…` for an `@handle`, or the link as given if it is already a URL. */
function channelUrl(link: string): string {
  return link.startsWith("@") ? `https://t.me/${link.slice(1)}` : link;
}

export async function channelLockMiddleware(ctx: MyContext, next: NextFunction) {
  // 1. Capture referral payload if user sent /start ref_123
  if (ctx.message?.text) {
    const refMatch = ctx.message.text.match(/\/start\s+(?:ref_)?(\d+)/);
    if (refMatch) {
      const referrerId = parseInt(refMatch[1], 10);
      if (referrerId !== ctx.from?.id) {
        ctx.session.referral = referrerId;
      }
    }
  }

  // 2. If no channel lock is configured or no user context, pass through
  const channelId = ctx.env.CHANNEL_LOCK;
  const channelLink = ctx.env.CHANNEL_LOCK_LINK;
  const userId = ctx.from?.id;

  if (!channelId || !userId || !channelLink) {
    return next();
  }

  // The lock is a customer-acquisition gate on the storefront. The admin
  // supergroup's own topics, and any other non-private chat this bot is in, are
  // not the storefront — and running `getChatMember` on every group message costs
  // an API round trip per update for no benefit.
  if (ctx.chat?.type !== "private") {
    return next();
  }

  // The owner is exempt. They cannot be locked out of their own bot by their own
  // channel: if they have never joined it, or left it, every admin screen — panels,
  // packages, deposit approvals — becomes unreachable, and the only way back in is
  // a redeploy with CHANNEL_LOCK removed.
  const ownerId = Number(ctx.env.OWNER);
  if (Number.isFinite(ownerId) && userId === ownerId) {
    return next();
  }

  // Allow the "Check Membership" button callback to pass through to its handler
  if (ctx.callbackQuery?.data === "start_joined") {
    return next();
  }

  // 3. Verify channel membership
  if (membershipAllows(await verifyMembership(ctx))) {
    return next();
  }

  // 4. User is not a member: send channel lock prompt
  const keyboard = new InlineKeyboard()
    .url(ctx._("buttons.join_channel"), channelUrl(channelLink)).row()
    .text(ctx._("buttons.check_member"), "start_joined");

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: ctx._("not_channel_member_alert", { link: channelLink }),
      show_alert: true,
    });
    return;
  }

  // HTML, not Markdown. `channelLink` is an operator-supplied `@handle`, and a
  // handle may contain `_` — which Markdown reads as emphasis, so a channel named
  // `@narnix_vpn` turned this prompt into a 400 and the user saw nothing at all.
  await ctx.reply(ctx._("not_channel_member", { link: esc(channelLink) }), {
    reply_markup: keyboard,
    parse_mode: "HTML",
  });
}
