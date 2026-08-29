import { Message } from "grammy/types";
import { InputRichBlock, RichText } from "grammy/types";
import { MyContext, Translator } from "../../types/context";
import { TranslationPath } from "../../types/i18n";
import {
  Ticket,
  TicketMessage,
  TicketMessageContentType,
  TicketMessageSender,
} from "../../types/database";
import { esc } from "../../core/wizard";
import { unixSeconds } from "../../utils/date";
import { getMessageStyle, MessageStyle, stampStyleHint } from "../../core/db/repositories/users";
import { markMessageDelivered, pendingMessagesFor, recentDeliveredMessages } from "./repo";
import { buildMessageStyleKeyboard } from "./keyboards";

/**
 * The ticket message ledger: what was said, and whether the other side has seen it.
 *
 * A ticket lives in two forum topics, one per party's private chat, and either party can
 * make theirs disappear at any time — by minimizing it, or by deleting the thread from
 * the Telegram UI. So "send the message into their thread" is not something that can be
 * relied on at the moment a message arrives. Every relayed message is therefore written
 * down here first, with `delivered_at` recording whether it reached the recipient's
 * thread; whatever is still owed is flushed the next time that thread exists.
 *
 * Without this the recipient got an alert for a message that was never anywhere: the
 * notice went to their main chat, the copy went nowhere, and "open and reply" built a
 * brand-new empty topic. See `migrations/0007_ticket_message_backlog.sql`.
 */

/** How much of a message body is kept for the alert and the digest. */
const PREVIEW_LENGTH = 200;

/**
 * How many owed messages are flushed into a newly opened thread in one go.
 *
 * Each one is a `copyMessage` subrequest and a Worker invocation gets 50 on the Free
 * plan, shared with everything else the same update triggers. Whatever does not fit is
 * *reported* rather than silently dropped — the recipient is told how many are still
 * waiting, and reopening the topic collects the next batch.
 */
const MAX_FLUSH = 15;

/** How many already-delivered messages the context digest recaps. */
const DIGEST_LIMIT = 8;

/** Locale key per content type, for describing a message that has no text of its own. */
const CONTENT_LABELS = {
  text: "ticket.content.text",
  photo: "ticket.content.photo",
  document: "ticket.content.document",
  video: "ticket.content.video",
  voice: "ticket.content.voice",
  audio: "ticket.content.audio",
  sticker: "ticket.content.sticker",
  video_note: "ticket.content.video_note",
  animation: "ticket.content.animation",
} as const satisfies Record<TicketMessageContentType, TranslationPath>;

/**
 * What a Telegram message is, and a short quotable version of it.
 *
 * Order matters: an animation also carries a `document`, and a video note also has a
 * `video`-shaped payload, so the more specific fields are tested first. Anything the
 * list does not recognise is recorded as `text` with no preview — it still relays
 * (`copyMessage` does not care what it is copying), it just cannot be quoted.
 */
export function describeMessage(message: Message): {
  contentType: TicketMessageContentType;
  preview: string | null;
} {
  const body = message.text ?? message.caption ?? null;
  const preview = body ? body.trim().slice(0, PREVIEW_LENGTH) || null : null;

  const contentType: TicketMessageContentType = message.animation
    ? "animation"
    : message.video_note
      ? "video_note"
      : message.sticker
        ? "sticker"
        : message.photo
          ? "photo"
          : message.video
            ? "video"
            : message.voice
              ? "voice"
              : message.audio
                ? "audio"
                : message.document
                  ? "document"
                  : "text";

  return { contentType, preview };
}

/**
 * One line describing a message, in the reader's language.
 *
 * A captioned photo reads as "📷 here is the receipt"; an uncaptioned one as "📷 photo".
 * Text is quoted on its own — prefixing every message with a "text" label would be noise
 * on the common case. Escaped for `parse_mode: "HTML"`, because this is user-supplied
 * text going into a formatted message.
 *
 * `content_type` comes back from a plain TEXT column, so a value outside the union is
 * possible (a hand-edited row, a type this bot no longer knows); it degrades to the
 * text label rather than rendering the raw key.
 *
 * `describeForRichText` is the same decision for the rich-blocks path; the two travel
 * together and a change to one belongs in the other.
 */
export function describeForReader(
  _: Translator,
  contentType: TicketMessageContentType,
  preview: string | null,
): string {
  if (contentType === "text") {
    return preview ? esc(preview) : _("ticket.content.text");
  }

  const label = _(CONTENT_LABELS[contentType] ?? "ticket.content.text");
  return preview ? `${label} — ${esc(preview)}` : label;
}

// Arguments for one ledger row: see `repo.ts#RecordMessageInput` — the ledger's
// writes live in the module's data layer, this file only renders what it returns.

/**
 * Writes one message to the ledger.
 *
 * Returns the new row id, or null if the insert failed. The caller decides what that
 * means: for a message that could not be delivered either, it is an actual loss and the
 * sender has to be told — the one case where silence would be worse than an error.
 */
// The ledger's writes (record, pending, digest, delivered marks) live in this
// module's data layer — `repo.ts` — and are imported at the top of this file.

/**
 * Messages still owed to one side, oldest first.
 *
 * "Owed to the owner" means the *user* sent it and it has not been delivered — nobody is
 * ever owed their own messages, so the sender role is the filter. One row over the cap is
 * fetched deliberately: it is how the caller knows to say "and N more" without a second
 * COUNT query.
 */
/**
 * One ledger row as blocks: a "who · when" line, then the message body.
 *
 * The timestamp is a `date_time` entity rather than a formatted string. It carries the
 * instant plus a format spec, and the *reader's* client renders it — their calendar,
 * their timezone, their language. That is what makes a timestamp usable here at all:
 * this bot has two locales and the only date formatters it owns hard-code the Persian
 * calendar, so any string this Worker rendered would be right for one reader and wrong
 * for the other. `format: "wdt"` is weekday + short date + short time. The entity's own
 * `text` is the underlying value the docs describe being shown as-is when no format is
 * requested; it gets the stored UTC string rather than being left empty.
 *
 * Two paragraphs rather than one with a line break in it: `RichText` has no line-break
 * member, and whether a literal newline inside a paragraph renders as one is not
 * documented — two paragraph blocks are.
 */
function messageBlocks(_: Translator, row: TicketMessage): InputRichBlock[] {
  const who = _(row.sender_role === "owner" ? "ticket.digest_who_owner" : "ticket.digest_who_user");

  return [
    {
      type: "paragraph",
      text: [
        { type: "bold", text: who },
        " · ",
        {
          type: "date_time",
          text: row.created_at,
          unix_time: unixSeconds(row.created_at),
          date_time_format: "wdt",
        },
      ],
    },
    // Plain, unescaped: rich blocks take text as data, so unlike the HTML path there is
    // no markup for a user's own `<` to break out of.
    { type: "paragraph", text: describeForRichText(_, row.content_type, row.preview) },
  ];
}

/**
 * The rich-text twin of `describeForReader`: same decision, no HTML escaping.
 *
 * Media keeps its label in bold so an uncaptioned photo still reads as something rather
 * than an empty line, and a captioned one shows label and caption on the same line.
 */
function describeForRichText(
  _: Translator,
  contentType: TicketMessageContentType,
  preview: string | null,
): RichText {
  if (contentType === "text") {
    return preview ?? { type: "italic", text: _("ticket.content.text") };
  }

  const label: RichText = { type: "bold", text: _(CONTENT_LABELS[contentType] ?? "ticket.content.text") };
  return preview ? [label, " — ", preview] : label;
}

/**
 * The recap, as rich blocks: a collapsed `details` disclosure the reader can expand.
 *
 * This is the whole reason for reaching for rich messages here. The recap exists so
 * someone arriving in a fresh topic has context — but as flat text it is also eight
 * messages of scrollback sitting on top of the one message they actually came to read.
 * A `details` block is a single summary line until tapped, so the context is *available*
 * without being *in the way*, and the summary names the count so it is obvious what is
 * folded up inside.
 *
 * Returns null when there is nothing to recap; the caller sends nothing at all then.
 */
export function renderDigestBlocks(_: Translator, rows: TicketMessage[]): InputRichBlock[] | null {
  if (rows.length === 0) return null;

  return [
    {
      type: "details",
      summary: { type: "bold", text: _("ticket.digest_title", { count: rows.length }) },
      blocks: [
        {
          type: "list",
          items: rows.map((row) => ({ blocks: messageBlocks(_, row) })),
        },
        { type: "footer", text: { type: "italic", text: _("ticket.digest_footer") } },
      ],
      // Closed by default: an open one would be exactly the flat wall of text this
      // replaces. The summary line names the count, so it is clear what is inside.
    },
  ];
}

/**
 * Renders the "here is what was said before" recap as HTML, or null when there is nothing.
 *
 * The fallback for `renderDigestBlocks` above, used when `sendRichMessage` is refused —
 * see `sendRich`. Deliberately flat: it is one `sendMessage` with no interaction, which
 * is the property that makes it a safe last resort.
 */
export function renderDigest(_: Translator, rows: TicketMessage[]): string | null {
  if (rows.length === 0) return null;

  const lines = rows.map((row) => {
    const who = _(
      row.sender_role === "owner" ? "ticket.digest_who_owner" : "ticket.digest_who_user",
    );

    return _("ticket.digest_line", {
      who,
      text: describeForReader(_, row.content_type, row.preview),
    });
  });

  // `digest_title` is plain text so the rich path can use it as a `details` summary,
  // which means this path is the one that has to add the emphasis.
  return [`<b>${esc(_("ticket.digest_title", { count: rows.length }))}</b>`, "", ...lines].join("\n");
}

/**
 * Sends rich blocks, falling back to a plain HTML message if that is refused.
 *
 * What the recipient sees when their Telegram client is too old to render a rich message
 * is not documented. The reference covers Rich Messages exhaustively — every block, every
 * tag, the limits — and says nothing about it; `sendRichMessage` names only media rights
 * and sender-side permission as failure conditions; there is no capability flag to test
 * and no companion text field on `InputRichMessage` to degrade *to* ("Exactly one of the
 * fields html, markdown, or blocks must be used").
 *
 * The changelog's convention for other version-gated features hints at what probably
 * happens — spoiler entities and ID-mention buttons both carry "Older clients will
 * display unsupported message" — but none of the three Rich Message entries (10.1
 * introduced them, 10.2 and 10.3 extended them) carries that note. Precedent, not promise.
 *
 * Either way it is not a failure this code could catch: it happens on the recipient's
 * device, and the API call succeeds. What the fallback below *does* cover is the API
 * refusing the call — for an account, a chat type, or a limit not yet understood. On any
 * rejection it sends the flat HTML version, which is what this code sent before rich
 * messages existed and is therefore known to work everywhere. A wrong guess costs one
 * wasted API call; no guess at all costs a ticket thread that silently shows nothing.
 *
 * `simple` closes the remaining gap from the only side that can see it. The bot cannot
 * detect an old client, so the reader is asked once (`offerStyleHint`) and their answer
 * is remembered on `users.simple_messages_at`; when it is set this skips the rich attempt
 * entirely rather than making a call that will render as a placeholder.
 *
 * `is_rtl` comes from the reader's own locale, not the message content — a Persian
 * reader's recap should lay out right-to-left even where a particular line is English.
 */
async function sendRich(
  ctx: MyContext,
  chatId: number,
  threadId: number,
  reader: Translator,
  blocks: InputRichBlock[],
  fallbackHtml: string,
  simple: boolean,
): Promise<void> {
  // The reader's standing answer to the question this code cannot ask their client.
  if (!simple) {
    const isRtl = reader("common.text_direction") === "rtl";

    try {
      await ctx.api.sendRichMessage(
        chatId,
        { blocks, ...(isRtl ? { is_rtl: true } : {}) },
        { message_thread_id: threadId },
      );
      return;
    } catch (err) {
      console.warn("rich message refused, falling back to HTML:", err);
    }
  }

  await ctx.api.sendMessage(chatId, fallbackHtml, {
    message_thread_id: threadId,
    parse_mode: "HTML",
  });
}

/**
 * Offers the escape hatch once, as a plain message, then never again.
 *
 * Sent *before* the recap rather than after it. A reader whose client cannot draw the
 * recap sees a placeholder where it should be, and the explanation is only useful if it
 * is already above that gap — arriving underneath, it reads as a comment on nothing.
 *
 * The stamp is written first. If the send then fails the notice is lost rather than
 * repeated, which is the right way round for something whose entire justification is
 * that it appears at most once.
 */
async function offerStyleHint(
  ctx: MyContext,
  chatId: number,
  threadId: number,
  reader: Translator,
): Promise<void> {
  try {
    await stampStyleHint(ctx.env.DB, chatId);

    await ctx.api.sendMessage(chatId, reader("ticket.style_hint"), {
      message_thread_id: threadId,
      parse_mode: "HTML",
      reply_markup: buildMessageStyleKeyboard(reader, false),
    });
  } catch (err) {
    console.warn(`could not offer style hint to ${chatId}:`, err);
  }
}

/**
 * Delivers everything owed to one side into a thread that now exists.
 *
 * Each message is marked the instant its copy succeeds rather than in one batch at the
 * end: if the invocation dies partway, at most the message being copied right then can
 * be delivered twice, instead of every message copied so far.
 *
 * A copy can also fail permanently — the sender deleted the original, or their side of
 * the chat is gone — and retrying it on every reopen would mean the backlog never drains
 * and the same failure repeats forever. So a failed copy falls back to the stored
 * preview as plain text, which loses the media but keeps the words, and the row is
 * marked delivered either way.
 */
export async function flushPending(
  ctx: MyContext,
  ticket: Ticket,
  recipient: TicketMessageSender,
  recipientChatId: number,
  threadId: number,
  reader: Translator,
  simple: boolean,
): Promise<void> {
  const owed = await pendingMessagesFor(ctx.env.DB, ticket.id, recipient, MAX_FLUSH + 1);
  if (owed.length === 0) return;

  const batch = owed.slice(0, MAX_FLUSH);
  const remaining = owed.length - batch.length;

  // A heading rather than a bold line: it is the divider between "what you already had"
  // and "what arrived while you were away", and the real messages follow it as copies.
  await sendRich(
    ctx,
    recipientChatId,
    threadId,
    reader,
    [
      { type: "heading", text: reader("ticket.backlog_title"), size: 3 },
      { type: "divider" },
    ],
    `<b>${esc(reader("ticket.backlog_title"))}</b>`,
    simple,
  );

  const senderChatId = recipient === "owner" ? ticket.user_id : Number(ctx.env.OWNER);
  let degraded = 0;

  for (const row of batch) {
    const sourceMsgId = recipient === "owner" ? row.user_msg_id : row.owner_msg_id;
    let copiedId: number | null = null;

    if (sourceMsgId !== null && Number.isFinite(senderChatId)) {
      try {
        const copy = await ctx.api.copyMessage(recipientChatId, senderChatId, sourceMsgId, {
          message_thread_id: threadId,
        });
        copiedId = copy.message_id;
      } catch (err) {
        console.warn(`ticket ${ticket.id}: message ${row.id} could not be copied`, err);
      }
    }

    if (copiedId === null) {
      degraded++;
      try {
        await ctx.api.sendMessage(
          recipientChatId,
          reader("ticket.backlog_degraded", {
            text: describeForReader(reader, row.content_type, row.preview),
          }),
          { message_thread_id: threadId, parse_mode: "HTML" },
        );
      } catch (err) {
        console.error(`ticket ${ticket.id}: message ${row.id} lost entirely`, err);
      }
    }

    await markMessageDelivered(ctx.env.DB, row.id, recipient, copiedId);
  }

  // Never truncate silently. A recipient who is told "12 earlier messages are still
  // waiting" can tap open again; one who is told nothing assumes they have read it all.
  if (remaining > 0 || degraded > 0) {
    const notes: string[] = [];
    if (remaining > 0) notes.push(reader("ticket.backlog_more", { count: remaining }));
    if (degraded > 0) notes.push(reader("ticket.backlog_degraded_note", { count: degraded }));

    await sendRich(
      ctx,
      recipientChatId,
      threadId,
      reader,
      notes.map((text) => ({ type: "paragraph", text: { type: "italic", text } })),
      notes.map(esc).join("\n"),
      simple,
    );
  }
}

/**
 * Everything a thread needs when it opens: the recap, then the messages owed.
 *
 * `digest` is on only for a *newly created* thread. A reused one still has the history
 * scrolled above it, and repeating the last eight messages every time someone taps "open
 * conversation" would be worse than saying nothing.
 */
export async function sendThreadContext(
  ctx: MyContext,
  ticket: Ticket,
  recipient: TicketMessageSender,
  recipientChatId: number,
  threadId: number,
  reader: Translator,
  opts: { digest: boolean },
): Promise<void> {
  try {
    // `recipientChatId` doubles as their `users.id`: a ticket's two sides are the customer
    // and the owner, and a private chat's id *is* the user's id. Topics live inside those
    // private chats, so there is no group id in play to confuse it with.
    const style = await getMessageStyle(ctx.env.DB, recipientChatId);

    if (opts.digest) {
      const rows = await recentDeliveredMessages(ctx.env.DB, ticket.id, DIGEST_LIMIT);
      const blocks = renderDigestBlocks(reader, rows);
      const html = renderDigest(reader, rows);

      if (blocks && html) {
        // Gated on there being a recap to send, so the notice never arrives on a thread
        // with nothing rich in it. The backlog header and trailing notes below are
        // cosmetic — a reader who loses those loses formatting, not information — so
        // they are not worth spending the one-time hint on.
        if (!style.simple && !style.hinted) {
          await offerStyleHint(ctx, recipientChatId, threadId, reader);
        }

        await sendRich(ctx, recipientChatId, threadId, reader, blocks, html, style.simple);
      }
    }

    await flushPending(ctx, ticket, recipient, recipientChatId, threadId, reader, style.simple);
  } catch (err) {
    // The thread and its header already exist by this point. A failure here costs
    // context, not the conversation, and must not propagate into a caller whose own
    // answer — "the topic is open" — is still true.
    console.error(`ticket ${ticket.id}: could not restore thread context`, err);
  }
}
