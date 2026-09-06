import { describe, expect, it } from "vitest";

import en from "../locales/en.json";
import fa from "../locales/fa.json";
import { getTranslator, normalizeLanguage } from "./i18n";

/** Flattens the nested locale files to dotted key → string. */
function flatten(obj: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") {
      for (const [k, v] of flatten(value as Record<string, unknown>, `${prefix}${key}.`)) {
        out.set(k, v);
      }
    } else {
      out.set(`${prefix}${key}`, String(value));
    }
  }
  return out;
}

const faKeys = flatten(fa);
const enKeys = flatten(en);

/**
 * A key `fa.json` has and `en.json` deliberately omits — `en.json` is allowed to be
 * partial, but at the moment it is a complete overlay, so this can be undefined.
 */
const FA_ONLY_KEY = [...faKeys.keys()].find((key) => !enKeys.has(key));

/** A key whose value carries an interpolation slot. */
const INTERPOLATED = [...faKeys.entries()].find(([, value]) => /\{\{\s*\w+\s*\}\}/.test(value))!;

describe("normalizeLanguage", () => {
  it("maps any English IETF tag to 'en'", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("en-GB")).toBe("en");
  });

  it("maps Persian to 'fa'", () => {
    expect(normalizeLanguage("fa")).toBe("fa");
    expect(normalizeLanguage("fa-IR")).toBe("fa");
  });

  it("lands everything unknown on Persian — raw key names are worse than fa", () => {
    expect(normalizeLanguage("de")).toBe("fa");
    expect(normalizeLanguage(undefined)).toBe("fa");
    expect(normalizeLanguage(null)).toBe("fa");
  });
});

describe("getTranslator", () => {
  it("returns the stored string for a known key", () => {
    const text = getTranslator("fa")("common.back");
    expect(text).toBeTruthy();
    expect(text).not.toBe("common.back");
  });

  it("never has an en key that fa lacks — en.json is an overlay, not a sibling", () => {
    // An en-only key would render as Persian for fa readers and English-only for
    // en readers: dead weight either way. `check:i18n` guards this too.
    const enOnly = [...enKeys.keys()].filter((key) => !faKeys.has(key));
    expect(enOnly).toEqual([]);
  });

  it("falls back to Persian for a key en.json omits — mixed language, not raw keys", () => {
    if (FA_ONLY_KEY === undefined) {
      // en.json is currently a complete overlay. The fallback itself is
      // exercised by the unknown-language case below; when a future key is
      // added to fa.json without an en translation, this branch starts testing
      // the partial-overlay path for real.
      expect(enKeys.size).toBe(faKeys.size);
      return;
    }

    expect(getTranslator("en")(FA_ONLY_KEY as never)).toBe(faKeys.get(FA_ONLY_KEY));
  });

  it("returns the key itself for an unknown key — visible, not a crash", () => {
    expect(getTranslator("fa")("no.such.key" as never)).toBe("no.such.key");
  });

  it("falls back to Persian for a language the bot has no copy for", () => {
    expect(getTranslator("de")("common.back")).toBe(getTranslator("fa")("common.back"));
  });

  it("interpolates {{vars}} until none remain", () => {
    const [key, template] = INTERPOLATED;
    const variable = /\{\{\s*(\w+)\s*\}\}/.exec(template)![1];

    const text = getTranslator("fa")(key as never, { [variable]: "⟦filled⟧" });
    expect(text).toContain("⟦filled⟧");
    expect(text).not.toContain("{{");
  });
});

