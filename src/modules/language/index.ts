import { Composer, InlineKeyboard } from "grammy";
import { MyContext } from "../../types/context";
import { BotModule } from "../../core/module";
import { SUPPORTED_LANGUAGES, getTranslator, setUserLanguage } from "../../utils/i18n";
import { SupportedLanguage } from "../../types/i18n";
import { showMainMenu } from "../start/utils";

/**
 * Language switching.
 *
 * Its own module rather than a corner of `start` because it is the one screen that
 * has to work *before* the user can read anything else — someone whose Telegram
 * client is set to a language this bot does not ship copy for lands on Persian, and
 * this is their way out of it.
 *
 * The write goes to `users.lang` (durable) *and* `ctx.session.lang` (the 24-hour
 * cache `resolveLanguage` reads). Updating only the row would leave the current
 * session rendering the old language until it expired; updating only the session
 * would lose the choice on expiry and, worse, keep sending admin notices and cron
 * warnings — which build their translator from the row via `translatorFor` — in the
 * language the user just abandoned.
 */

const composer = new Composer<MyContext>();

/** `language.fa` / `language.en` — the button label for each language, in itself. */
function languageLabel(lang: SupportedLanguage): "language.fa" | "language.en" {
  return lang === "en" ? "language.en" : "language.fa";
}

function buildLanguageKeyboard(ctx: MyContext): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const lang of SUPPORTED_LANGUAGES) {
    // The current language is marked rather than hidden, so the screen always shows
    // the same options in the same order and tapping the active one is harmless.
    const mark = lang === ctx.session.lang ? "✅ " : "";
    keyboard.text(mark + ctx._(languageLabel(lang)), `set_lang:${lang}`).row();
  }

  return keyboard.text(ctx._("common.back_to_main"), "action_cancel");
}

async function showLanguageMenu(ctx: MyContext, isEdit: boolean): Promise<void> {
  const text = ctx._("language.title", {
    current: ctx._(languageLabel(ctx.session.lang ?? "fa")),
  });
  const options = { reply_markup: buildLanguageKeyboard(ctx), parse_mode: "HTML" } as const;

  if (isEdit && ctx.callbackQuery) {
    await ctx.editMessageText(text, options);
  } else {
    await ctx.reply(text, options);
  }
}

composer.command("language", async (ctx) => await showLanguageMenu(ctx, false));

composer.callbackQuery("user_language", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showLanguageMenu(ctx, true);
});

composer.callbackQuery(/^set_lang:(\w+)$/, async (ctx) => {
  const requested = ctx.match[1];
  const userId = ctx.from?.id;

  // Callback data is user-supplied. An unknown tag must not reach `getTranslator`,
  // which would index the dictionary map with it and hand every later `_()` call an
  // undefined dictionary.
  if (!SUPPORTED_LANGUAGES.includes(requested as SupportedLanguage) || !userId) {
    await ctx.answerCallbackQuery();
    return;
  }

  const lang = requested as SupportedLanguage;

  // The return value is deliberately ignored. `false` means "no row to update", which
  // only happens for a user who has never reached `ensureUser` — and `showMainMenu`
  // below calls it, inserting the row with the `session.lang` set on the next line.
  // Either way the choice ends up persisted.
  await setUserLanguage(ctx.env.DB, userId, lang);

  // Set both, then rebuild the translator by hand: `ctx._` was bound by
  // `resolveLanguage` at the top of this update and does not re-derive itself, so
  // without this line the confirmation below would be written in the *old* language.
  ctx.session.lang = lang;
  ctx._ = getTranslator(lang);

  await ctx.answerCallbackQuery({
    text: ctx._("language.changed", { name: ctx._(languageLabel(lang)) }),
  });

  // Straight back to the main menu, re-rendered in the new language — the switch is
  // only believable if the very next screen is in the language just chosen.
  await showMainMenu(ctx, true);
});

export const LanguageModule: BotModule = {
  id: "language",
  name: "Language Switcher",
  composer,
};
