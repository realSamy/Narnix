import { InlineKeyboard } from "grammy";
import { MyConversation, MyConversationContext } from "../types/context";

/**
 * Building blocks shared by every wizard (`@grammyjs/conversations` builder).
 *
 * ## What is and is not replay-safe
 *
 * A conversation builder is re-executed from the top on every update it
 * receives. Two categories of side effect behave differently:
 *
 *  - **Bot API calls are safe.** The plugin hands each conversation its own `Api`
 *    instance wrapped in a recording transformer (`plugin.js#hydrateContext`), so
 *    `ctx.reply(...)` fires once and every replay reads the stored response back.
 *    You do not need to wrap messages in `conversation.external()`.
 *  - **Everything else is not.** D1 queries, `Date.now()`, `Math.random()`,
 *    `crypto.randomUUID()`, the `utils/random.ts` helpers and session access all
 *    re-run on every replay. Wrap them in `conversation.external()`, or use
 *    `conversation.now()` / `conversation.random()`.
 *
 * A double-INSERT is the classic symptom of getting this wrong.
 *
 * ## Why every wait goes through `waitAccepting`
 *
 * The obvious tools — `conversation.waitFor("message:text")` and the built-in
 * `conversation.form.*` helpers — drop non-matching updates by default. A user who
 * taps an inline button mid-wizard would get a Telegram spinner that never
 * resolves, and a user who types `/start` to escape would have it silently eaten
 * as form input. `waitAccepting` responds to every update instead, which is why
 * all the `ask*` helpers are built on it rather than on the library's.
 */

/** Sending this at any prompt aborts the wizard. */
export const CANCEL_COMMAND = "/cancel";

/** Callback data for the inline "cancel" button on keyboard prompts. */
export const CANCEL_DATA = "wizard_cancel";

/** Result of validating one answer: either a parsed value or a reason to retry. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const fail = (error: string): Parsed<never> => ({ ok: false, error });

/**
 * What an `accept` callback tells `waitAccepting`: the update carried the value we
 * were waiting for, or it did not (with an optional explanation to show the user).
 */
export type Verdict<T> = { accepted: true; value: T } | { accepted: false; complain?: string };

/** Anything Telegram accepts as `reply_markup` on an outgoing message. */
type ReplyMarkup = NonNullable<Parameters<MyConversationContext["reply"]>[1]>["reply_markup"];

/**
 * Waits for an update that `accept` recognises, handling every way the user can go
 * off-script before `accept` is consulted:
 *
 *  - `/cancel`, or the inline cancel button → abort, consuming the update.
 *  - any other command → abort *and* let the command through, so `/start` still
 *    works as an escape hatch instead of being eaten as form input. Prompts whose
 *    valid answers can begin with a slash (a URL path, say) opt out with
 *    `slashIsText`; `/cancel` keeps working there regardless.
 *  - anything `accept` rejects → explained and re-asked. A rejected callback query
 *    is always answered, because an unanswered one leaves a spinner on the button
 *    forever; that is handled here rather than in each `accept` so it cannot be
 *    forgotten.
 */
async function waitAccepting<T>(
  conversation: MyConversation,
  ctx: MyConversationContext,
  accept: (answer: MyConversationContext) => Verdict<T> | Promise<Verdict<T>>,
  slashIsText = false,
): Promise<T> {
  while (true) {
    const answer = await conversation.wait();
    const text = answer.message?.text?.trim();

    if (text === CANCEL_COMMAND || answer.callbackQuery?.data === CANCEL_DATA) {
      if (answer.callbackQuery) await answer.answerCallbackQuery();
      await answer.reply(ctx._("wizard.cancelled"), {
        reply_markup: { remove_keyboard: true },
      });
      await conversation.halt();
    }

    if (!slashIsText && text?.startsWith("/")) {
      await answer.reply(ctx._("wizard.aborted_by_command"), {
        reply_markup: { remove_keyboard: true },
      });
      // `next: true` hands the update to the middleware downstream of the
      // wizard, so the command the user actually typed gets to run.
      await conversation.halt({ next: true });
    }

    const verdict = await accept(answer);
    if (verdict.accepted) return verdict.value;

    if (answer.callbackQuery) {
      await answer.answerCallbackQuery({
        text: verdict.complain ?? ctx._("wizard.busy"),
        show_alert: true,
      });
    } else if (verdict.complain) {
      await ctx.reply(`⚠️ ${verdict.complain}`, { parse_mode: "HTML" });
    }
  }
}

/** Sends a prompt with the "you can /cancel" footer appended. */
async function sendPrompt(
  ctx: MyConversationContext,
  prompt: string,
  keyboard?: ReplyMarkup,
): Promise<void> {
  await ctx.reply(`${prompt}\n\n<i>${ctx._("wizard.cancel_hint")}</i>`, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

/**
 * The general form of every helper below: ask once, then keep waiting until
 * `accept` recognises an answer.
 *
 * Exported as the escape hatch for prompts none of the typed helpers cover — a
 * `requestUsers` keyboard, for instance, whose answer arrives as `users_shared`
 * rather than as text. Prefer `ask`/`askInt`/`askChoice`/`askPhoto` when they fit.
 */
export async function askUsing<T>(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
  accept: (answer: MyConversationContext) => Verdict<T> | Promise<Verdict<T>>,
  opts: { keyboard?: ReplyMarkup; slashIsText?: boolean } = {},
): Promise<T> {
  await sendPrompt(ctx, prompt, opts.keyboard);
  return waitAccepting(conversation, ctx, accept, opts.slashIsText);
}

/**
 * Asks a question and returns the validated answer, re-prompting until it passes.
 *
 * `parse` turns raw text into the value the caller wants, or explains what was
 * wrong. Validation lives here rather than after the wizard so a typo costs one
 * message instead of the whole form.
 *
 * Set `slashIsText` for fields whose answers can start with `/`, such as a URL
 * path — otherwise the command escape hatch would read them as an attempt to leave.
 */
export function ask<T>(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
  parse: (text: string) => Parsed<T>,
  opts: { slashIsText?: boolean } = {},
): Promise<T> {
  return askUsing<T>(
    conversation,
    ctx,
    prompt,
    (answer) => {
      // A tapped button is not an answer to a text prompt; the central handler
      // turns this into the "finish the form first" alert.
      if (answer.callbackQuery) return { accepted: false };

      const text = answer.message?.text?.trim();
      if (!text) return { accepted: false, complain: ctx._("wizard.expects_text") };

      const result = parse(text);
      return result.ok
        ? { accepted: true, value: result.value }
        : { accepted: false, complain: result.error };
    },
    opts,
  );
}

/** Asks for free-form text, rejecting only the empty and over-long cases. */
export function askText(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
  opts: { maxLength?: number } = {},
): Promise<string> {
  const { maxLength = 200 } = opts;

  return ask(conversation, ctx, prompt, (text) =>
    text.length > maxLength
      ? fail(ctx._("wizard.too_long", { max: String(maxLength) }))
      : ok(text),
  );
}

/**
 * Asks for a credential. Same validation as `askText`, but the admin's reply is
 * deleted from the chat the moment it is accepted.
 *
 * A 3X-UI bearer token typed into a chat otherwise stays in that chat's history — on
 * the phone, on desktop, and on Telegram's servers — for as long as the chat exists,
 * where it is a far easier thing to stumble across than the D1 row it ends up in.
 * (The row is still plaintext; that is a separate decision. This is the cheap half.)
 *
 * The delete is best-effort. The Bot API allows deleting incoming messages in private
 * chats, which is where the admin wizards run, but it needs the message to be under
 * 48 hours old and it fails harmlessly if the admin got there first — so a failure is
 * logged and the wizard carries on rather than losing the answer.
 */
export function askSecret(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
  opts: { maxLength?: number } = {},
): Promise<string> {
  const { maxLength = 512 } = opts;

  return askUsing<string>(conversation, ctx, prompt, async (answer) => {
    if (answer.callbackQuery) return { accepted: false };

    const text = answer.message?.text?.trim();
    if (!text) return { accepted: false, complain: ctx._("wizard.expects_text") };
    if (text.length > maxLength) {
      return { accepted: false, complain: ctx._("wizard.too_long", { max: String(maxLength) }) };
    }

    try {
      await answer.deleteMessage();
    } catch (err) {
      console.error("askSecret: could not delete the credential message", err);
    }

    return { accepted: true, value: text };
  });
}

/** Asks for a whole number within an inclusive range. */
export function askInt(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
  opts: { min?: number; max?: number } = {},
): Promise<number> {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = opts;

  return ask(conversation, ctx, prompt, (text) => {
    const value = Number(normalizeDigits(text));

    if (!Number.isInteger(value)) return fail(ctx._("wizard.expects_integer"));
    if (value < min || value > max) {
      return fail(
        ctx._("wizard.out_of_range", { min: String(min), max: String(max) }),
      );
    }

    return ok(value);
  });
}

/** Asks for a possibly fractional amount within an inclusive range. */
export function askNumber(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
  opts: { min?: number; max?: number } = {},
): Promise<number> {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = opts;

  return ask(conversation, ctx, prompt, (text) => {
    const value = Number(normalizeDigits(text));

    if (!Number.isFinite(value)) return fail(ctx._("wizard.expects_number"));
    if (value < min || value > max) {
      return fail(
        ctx._("wizard.out_of_range", { min: String(min), max: String(max) }),
      );
    }

    return ok(value);
  });
}

/** One selectable option in an `askChoice` prompt. */
export interface Choice<T> {
  /** Button label. */
  label: string;
  /** Value handed back to the wizard when this button is tapped. */
  value: T;
}

/**
 * Asks the user to pick one of a fixed set of options via inline buttons.
 *
 * Callback data is generated here (`wizard_pick:<index>`) rather than taken from
 * the caller, so option values are free to be any shape — a whole row object, for
 * instance — without having to survive a round trip through a 64-byte data field.
 */
export async function askChoice<T>(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
  choices: Choice<T>[],
  opts: { columns?: number } = {},
): Promise<T> {
  const { columns = 1 } = opts;

  const keyboard = new InlineKeyboard();
  choices.forEach((choice, index) => {
    keyboard.text(choice.label, `wizard_pick:${index}`);
    if ((index + 1) % columns === 0) keyboard.row();
  });
  keyboard.row().text(`🔙 ${ctx._("wizard.cancel_button")}`, CANCEL_DATA);

  return askUsing<T>(
    conversation,
    ctx,
    prompt,
    async (answer) => {
      const data = answer.callbackQuery?.data;

      if (!data?.startsWith("wizard_pick:")) {
        return { accepted: false, complain: ctx._("wizard.expects_choice") };
      }

      const index = Number(data.slice("wizard_pick:".length));
      const choice = choices[index];
      if (!choice) return { accepted: false, complain: ctx._("wizard.expects_choice") };

      // `askUsing` only answers the queries it *rejects*, so the accepted tap has
      // to be cleared here or its spinner never stops.
      await answer.answerCallbackQuery();
      return { accepted: true, value: choice.value };
    },
    { keyboard },
  );
}

/** Asks a yes/no question. Returns `true` only for an explicit confirmation. */
export function confirm(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
): Promise<boolean> {
  return askChoice<boolean>(
    conversation,
    ctx,
    prompt,
    [
      { label: `✅ ${ctx._("wizard.yes")}`, value: true },
      { label: `❌ ${ctx._("wizard.no")}`, value: false },
    ],
    { columns: 2 },
  );
}

/** Asks for a photo and returns the `file_id` of its largest available size. */
export function askPhoto(
  conversation: MyConversation,
  ctx: MyConversationContext,
  prompt: string,
): Promise<string> {
  return askUsing<string>(conversation, ctx, prompt, (answer) => {
    if (answer.callbackQuery) return { accepted: false };

    const photo = answer.message?.photo;
    if (!photo?.length) {
      return { accepted: false, complain: ctx._("wizard.expects_photo") };
    }

    // Telegram sorts sizes ascending, so the last entry is the highest resolution.
    return { accepted: true, value: photo[photo.length - 1].file_id };
  });
}

/**
 * Converts Persian and Arabic-Indic digits to ASCII and strips grouping
 * characters.
 *
 * Users type on Persian keyboards, so `۲۰۵۳` and `1,000` both have to parse. The
 * old handlers used bare `parseInt`, which returns `NaN` for the former and
 * silently truncates the latter to `1`.
 */
export function normalizeDigits(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    // Arabic decimal separator (U+066B) and thousands separator (U+066C): the
    // Persian keyboard's own "١٢٬٣٤٥" grouping, which ASCII stripping misses.
    .replace(/٫/g, ".")
    .replace(/[,،٬\s‌]/g, "");
}

/** Escapes text for `parse_mode: "HTML"`. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
