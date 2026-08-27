import { D1Database } from "@cloudflare/workers-types";
import fa from "../locales/fa.json";
import en from "../locales/en.json";
import { Translator } from "../types/context";
import { SupportedLanguage } from "../types/i18n";
import { findUserById, setUserLanguage as persistUserLanguage } from "../core/db/repositories/users";

export type { SupportedLanguage };

/** Every language the bot has copy for, in the order a picker should list them. */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["fa", "en"];

const dictionaries: Record<SupportedLanguage, Record<string, any>> = {
  fa,
  en,
};

/**
 * Coerces anything language-shaped into a language this bot actually has copy for.
 *
 * Handles both inputs that reach us: a stored `users.lang` (exactly `"fa"`/`"en"`,
 * but `NULL` for rows predating the column default) and a Telegram
 * `from.language_code`, which is an IETF tag — `"en"`, `"en-GB"`, `"fa-IR"`. The
 * prefix test covers both. Everything else, including `"de"`, lands on Persian:
 * this is a Persian-language product and a German speaker is better served by the
 * language the shop is actually written in than by raw key names.
 */
export function normalizeLanguage(raw: string | null | undefined): SupportedLanguage {
  return raw?.toLowerCase().startsWith("en") ? "en" : "fa";
}

/**
 * Resolves nested object keys like "main_menu.shop"
 */
function getNestedValue(obj: any, path: string): string | undefined {
  return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

/**
 * Returns a translator function for the given language.
 *
 * `en.json` is allowed to be partial: any key it omits falls back to Persian, so a
 * half-translated locale degrades to mixed language rather than to raw key names.
 */
export function getTranslator(lang: string = "fa"): Translator {
  const selectedLang = (lang in dictionaries ? lang : "fa") as SupportedLanguage;
  const dict = dictionaries[selectedLang];

  return function translate(key, vars) {
    let text = getNestedValue(dict, key) || getNestedValue(dictionaries.fa, key) || key;

    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        text = text.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v));
      });
    }

    return text;
  };
}

/**
 * Returns a translator for *another* user's language.
 *
 * A deposit approval, a ticket reply or a broadcast is written for whoever
 * receives it, not for whoever triggered it. Using `ctx._` there renders the
 * admin's language into the customer's chat — invisible to the admin, because the
 * message looks right in the copy they are reading.
 *
 * Falls back to Persian for a user who has never picked a language, and for a user
 * row that has since been deleted.
 */
export async function translatorFor(db: D1Database, userId: number): Promise<Translator> {
  const row = await findUserById(db, userId);
  return getTranslator(normalizeLanguage(row?.lang));
}

/**
 * Reads a user's stored language, or `null` if they have no row yet.
 *
 * Used to hydrate the session cache exactly once (see `core/bot.ts`). The `null`
 * return is meaningful and distinct from `"fa"`: it says "no preference recorded",
 * which is the caller's cue to fall back to the Telegram client language rather
 * than to assume Persian.
 */
export async function getUserLanguage(
  db: D1Database,
  userId: number,
): Promise<SupportedLanguage | null> {
  const row = await findUserById(db, userId);

  if (!row || row.lang === null) return null;
  return normalizeLanguage(row.lang);
}

/**
 * Persists a language choice.
 *
 * `users.lang` is the durable record; `session.lang` is a 24-hour cache of it, so
 * a switcher has to write both or the change reverts when the session expires —
 * or, worse, applies to the user's own screens while every notice *about* them
 * (built with `translatorFor`) keeps arriving in the old language.
 *
 * Returns whether a row was actually updated, so a caller can tell a real switch
 * from a write against a user who does not exist.
 */
export async function setUserLanguage(
  db: D1Database,
  userId: number,
  lang: SupportedLanguage,
): Promise<boolean> {
  return persistUserLanguage(db, userId, lang);
}
