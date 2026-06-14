// -----------------------------------------------------------------------------
// Translation key types.
//
// Derived directly from the Persian locale file, which is the source of truth
// for the full key set (en.json is allowed to be a partial override — the
// translator falls back to fa for any missing key). Because the type is derived
// rather than generated, it can never drift out of sync with the JSON, so there
// is no generator script to run.
// -----------------------------------------------------------------------------

import fa from "../locales/fa.json";

/** Shape of the complete translation dictionary. */
export type TranslationSchema = typeof fa;

/**
 * Every dotted leaf path through a nested object type.
 * e.g. `{ a: { b: string } }` -> `"a.b"`
 */
export type NestedPaths<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? `${K}.${NestedPaths<T[K]>}`
        : `${K}`;
    }[keyof T & string]
  : never;

/** Union of all valid translation keys, e.g. `"main_menu.shop"`. */
export type TranslationPath = NestedPaths<TranslationSchema>;

/**
 * The languages this bot ships copy for.
 *
 * Lives here rather than in `utils/i18n.ts` so `types/context.d.ts` can type
 * `SessionData.lang` with it without the types layer importing from the runtime
 * layer. `utils/i18n.ts` re-exports it for callers already importing from there.
 */
export type SupportedLanguage = "fa" | "en";
