import { MyContext } from "../../types/context";
import { Ticket } from "../../types/database";
import { buildUserTopicControls, buildOwnerTopicControls } from "./keyboards";
import { sendThreadContext } from "./messages";
import { esc } from "../../core/wizard";
import { translatorFor } from "../../utils/i18n";

/**
 * Forum topics in *private chats* (Bot API 9.3+).
 *
 * Only three of the topic methods were extended to private chats: create, edit and
 * delete. `closeForumTopic`/`reopenForumTopic` remain supergroup-only, which is why
 * "minimize" below deletes the topic rather than closing it — there is no reversible
 * close available, and the ticket row keeps the state instead.
 *
 * Because minimizing destroys the thread, opening one is also the moment to hand back
 * whatever was said while it was gone: both `open*Topic` functions finish by calling
 * `sendThreadContext`, which replays the messages this side is still owed (see
 * `messages.ts`). A newly created thread additionally gets a recap of the conversation
 * so far — it starts empty, and the party arriving in it has no history to scroll.
 */

/** Truncates a title to Telegram's 128-character limit. */
function sanitizeTopicTitle(title: string): string {
    return title.trim().slice(0, 128);
}

/**
 * Deletes a forum topic, tolerating a topic that is already gone.
 *
 * The user can delete their own topic from the Telegram UI at any time, so a stored
 * `*_topic_id` is never a guarantee that the thread still exists.
 */
export async function safeDeleteTopic(ctx: MyContext, chatId: number, threadId: number): Promise<void> {
    try {
        await ctx.api.deleteForumTopic(chatId, threadId);
    } catch (err) {
        // Topic may have been closed or deleted manually
    }
}

/**
 * Whether this bot can create topics in a private chat at all.
 *
 * `has_topics_enabled` is returned only from `getMe`, which grammY caches on
 * `ctx.me`. Checking it turns an unavoidable 400 into a clean, explainable failure —
 * and the caller can tell the user something true instead of "topic opened".
 */
function canUsePrivateTopics(ctx: MyContext): boolean {
    return ctx.me?.has_topics_enabled === true;
}

/**
 * Opens — or reuses — the user's ticket topic, returning its thread id.
 *
 * The previous implementation deleted `user_topic_id` and created a fresh topic on
 * every call, so tapping "open conversation" on an already-open ticket destroyed the
 * live thread and the entire support history with it. Sending the header into the
 * existing thread first is also the *test* of whether that thread still exists: if the
 * user deleted it, the send throws and the recreate path runs.
 */
export async function openUserTopic(ctx: MyContext, ticket: Ticket): Promise<number | null> {
    const userId = ticket.user_id;
    const _u = await translatorFor(ctx.env.DB, userId);

    const header = _u("ticket.user_topic_header", {
        id: ticket.id,
        subject: esc(ticket.subject ?? ""),
    });
    const controls = buildUserTopicControls(_u, ticket.id);

    // 1. Reuse the existing thread when there is one.
    if (ticket.user_topic_id) {
        try {
            await ctx.api.sendMessage(userId, header, {
                message_thread_id: ticket.user_topic_id,
                reply_markup: controls,
                parse_mode: "HTML",
            });

            // Anything that arrived while this side was minimized is owed to them. No
            // digest: the thread is the same one, so its history is still scrolled above.
            await sendThreadContext(ctx, ticket, "user", userId, ticket.user_topic_id, _u, {
                digest: false,
            });

            return ticket.user_topic_id;
        } catch (err) {
            // Thread is gone (deleted by the user, or lost with a cleared chat). Fall
            // through and build a new one.
            console.warn(`User topic ${ticket.user_topic_id} unusable, recreating:`, err);
        }
    }

    if (!canUsePrivateTopics(ctx)) return null;

    // 2. Create a replacement.
    try {
        const topicTitle = sanitizeTopicTitle(
            _u("ticket.topic_title_user", { id: ticket.id, subject: ticket.subject ?? "" }),
        );
        const topic = await ctx.api.createForumTopic(userId, topicTitle);
        const threadId = topic.message_thread_id;

        await ctx.env.DB.prepare("UPDATE tickets SET user_topic_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(threadId, ticket.id)
            .run();

        await ctx.api.sendMessage(userId, header, {
            message_thread_id: threadId,
            reply_markup: controls,
            parse_mode: "HTML",
        });

        // A brand-new thread is empty, so it gets the recap first and then the backlog.
        // Both are no-ops on a ticket that has no messages yet, which is why calling this
        // from the ticket-creation path costs nothing.
        await sendThreadContext(ctx, ticket, "user", userId, threadId, _u, { digest: true });

        return threadId;
    } catch (err) {
        console.error("❌ Failed to create user forum topic:", err);
        return null;
    }
}

/**
 * Opens — or reuses — the owner's mirror topic. Same reuse-first logic as above.
 */
export async function openOwnerTopic(ctx: MyContext, ticket: Ticket): Promise<number | null> {
    // `OWNER` is a string binding, and a misconfigured one yields NaN rather than
    // throwing — which Telegram would then reject as an invalid chat id.
    const ownerId = Number(ctx.env.OWNER);
    if (!Number.isFinite(ownerId)) return null;

    const _o = await translatorFor(ctx.env.DB, ownerId);

    const header = _o("ticket.owner_topic_header", {
        id: ticket.id,
        userId: ticket.user_id,
        subject: esc(ticket.subject ?? ""),
    });
    const controls = buildOwnerTopicControls(_o, ticket.id);

    if (ticket.owner_topic_id) {
        try {
            await ctx.api.sendMessage(ownerId, header, {
                message_thread_id: ticket.owner_topic_id,
                reply_markup: controls,
                parse_mode: "HTML",
            });

            await sendThreadContext(ctx, ticket, "owner", ownerId, ticket.owner_topic_id, _o, {
                digest: false,
            });

            return ticket.owner_topic_id;
        } catch (err) {
            console.warn(`Owner topic ${ticket.owner_topic_id} unusable, recreating:`, err);
        }
    }

    if (!canUsePrivateTopics(ctx)) return null;

    try {
        const topicTitle = sanitizeTopicTitle(
            _o("ticket.topic_title_owner", {
                id: ticket.id,
                userId: ticket.user_id,
                subject: ticket.subject ?? "",
            }),
        );
        const topic = await ctx.api.createForumTopic(ownerId, topicTitle);
        const threadId = topic.message_thread_id;

        await ctx.env.DB.prepare("UPDATE tickets SET owner_topic_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(threadId, ticket.id)
            .run();

        await ctx.api.sendMessage(ownerId, header, {
            message_thread_id: threadId,
            reply_markup: controls,
            parse_mode: "HTML",
        });

        // This is the tap on "open and reply" in the notification: the owner arrives here
        // expecting to find the message they were just alerted about.
        await sendThreadContext(ctx, ticket, "owner", ownerId, threadId, _o, { digest: true });

        return threadId;
    } catch (err) {
        console.error("❌ Failed to create owner forum topic:", err);
        return null;
    }
}

/**
 * Minimizes a ticket topic for one party.
 *
 * The ticket stays open; only that side's thread is dismissed, and the stored id is
 * cleared so the relay knows to reopen on the next message. The other party is
 * unaffected and is not told.
 */
export async function minimizeTopic(ctx: MyContext, ticketId: number, isOwner: boolean): Promise<void> {
    const ticket = await ctx.env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
        .bind(ticketId)
        .first<Ticket>();

    if (!ticket) return;

    if (isOwner) {
        // Guarded, unlike before: a bad `OWNER` binding used to reach
        // `sendMessage(NaN, …)` here, while `closeTicket` right below checked it.
        const ownerId = Number(ctx.env.OWNER);
        if (!Number.isFinite(ownerId)) return;

        if (ticket.owner_topic_id) {
            await safeDeleteTopic(ctx, ownerId, ticket.owner_topic_id);
        }
        await ctx.env.DB.prepare("UPDATE tickets SET owner_topic_id = NULL WHERE id = ?").bind(ticketId).run();

        const _o = await translatorFor(ctx.env.DB, ownerId);
        await ctx.api.sendMessage(ownerId, _o("ticket.owner_minimized", { id: ticketId }), {
            parse_mode: "HTML",
        });
    } else {
        if (ticket.user_topic_id) {
            await safeDeleteTopic(ctx, ticket.user_id, ticket.user_topic_id);
        }
        await ctx.env.DB.prepare("UPDATE tickets SET user_topic_id = NULL WHERE id = ?").bind(ticketId).run();

        const _u = await translatorFor(ctx.env.DB, ticket.user_id);
        await ctx.api.sendMessage(ticket.user_id, _u("ticket.user_minimized"), {
            parse_mode: "HTML",
        });
    }
}

/**
 * Closes a ticket for both peers and destroys both topics.
 */
export async function closeTicket(ctx: MyContext, ticketId: number): Promise<void> {
    const ticket = await ctx.env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
        .bind(ticketId)
        .first<Ticket>();

    if (!ticket || ticket.status === "closed") return;

    const ownerId = Number(ctx.env.OWNER);
    const ownerValid = Number.isFinite(ownerId);

    // Destroy both forum topics
    if (ticket.user_topic_id) {
        await safeDeleteTopic(ctx, ticket.user_id, ticket.user_topic_id);
    }
    if (ticket.owner_topic_id && ownerValid) {
        await safeDeleteTopic(ctx, ownerId, ticket.owner_topic_id);
    }

    // Update status in D1
    await ctx.env.DB.prepare(`
    UPDATE tickets
    SET status = 'closed', user_topic_id = NULL, owner_topic_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
        .bind(ticketId)
        .run();

    // Notify both peers, each in their own language.
    try {
        const _u = await translatorFor(ctx.env.DB, ticket.user_id);
        await ctx.api.sendMessage(ticket.user_id, _u("ticket.closed_for_user", { id: ticket.id }), {
            parse_mode: "HTML",
        });
    } catch {}

    if (ownerValid) {
        try {
            const _o = await translatorFor(ctx.env.DB, ownerId);
            await ctx.api.sendMessage(
                ownerId,
                _o("ticket.closed_for_owner", { id: ticket.id, userId: ticket.user_id }),
                { parse_mode: "HTML" },
            );
        } catch {}
    }
}
