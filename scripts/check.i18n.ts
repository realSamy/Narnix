/**
 * Locale audit.
 *
 * Run with `pnpm check:i18n`. Reports, in order of how much each matters:
 *
 *  1. **Orphan keys** — `_("…")` calls whose key is missing from `fa.json`. These
 *     render as the raw key in the user's chat. `tsc` catches literal keys via
 *     `TranslationPath`; this catches the rest (keys built by other means).
 *  2. **`en.json` drift** — keys `fa.json` has that `en.json` lacks (an English
 *     user sees Persian there), and keys `en.json` has that `fa.json` does not
 *     (dead weight, usually a typo).
 *  3. **Unused keys** — present in `fa.json`, referenced nowhere.
 *  4. **Un-extracted text** — string literals in source that still contain
 *     Arabic-script characters, per file. This is the progress meter for moving
 *     hardcoded copy into the locale files; comments are excluded, so a non-zero
 *     count is a to-do list rather than an error.
 *
 * Exits non-zero only for 1 and for `en`-only keys: the rest are debt reports, not
 * build breakers.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import fa from "../src/locales/fa.json";
import en from "../src/locales/en.json";

// Resolved from this file's own location, so the audit runs from any working
// directory rather than only from the repository root. (`.href`, not the URL
// object itself: `fileURLToPath` wants Node's URL type.)
const SRC = fileURLToPath(new URL("../src", import.meta.url).href);

/** Every `.ts` file under `src`, excluding tests and type declarations. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!entry.endsWith(".ts")) return [];
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) return [];
    return [path];
  });
}

function flatten(obj: Record<string, any>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") {
      for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
    } else {
      out.set(`${prefix}${key}`, String(value));
    }
  }
  return out;
}

const faKeys = flatten(fa);
const enKeys = flatten(en);

/** `_("some.key")` / `_('some.key')` — the only shape the codebase uses. */
const CALL = /\b_\(\s*["'`]([\w.]+)["'`]/g;

/**
 * Comments and string literals, in one alternation.
 *
 * Matching both together is what makes this reliable: a `//` inside a string is
 * consumed as part of the string, and an apostrophe inside a prose comment is
 * consumed as part of the comment, so neither can unbalance the other. Only the
 * matches that begin with a quote are copy; the rest are documentation.
 */
const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

const PERSIAN = /[؀-ۿ]/;

const used = new Set<string>();
const untranslated: Array<{ file: string; count: number; samples: string[] }> = [];

for (const file of sourceFiles(SRC)) {
  const source = readFileSync(file, "utf8");

  for (const match of source.matchAll(CALL)) used.add(match[1]);

  const literals = [...source.matchAll(TOKEN)]
    .map((m) => m[0])
    .filter((token) => /^["'`]/.test(token));

  // Second pass for keys that reach `_()` without being adjacent to it — the
  // `_(cond ? 'a.b' : 'a.c')` shape, or a key held in a variable. Any string
  // literal that is *exactly* an existing key counts as a reference. `tsc` already
  // proves these are valid keys via `TranslationPath`; this only stops them from
  // being reported as dead.
  for (const token of literals) {
    const inner = token.slice(1, -1);
    if (faKeys.has(inner)) used.add(inner);
  }

  const persian = literals
    .filter((token) => PERSIAN.test(token))
    .map((token) => token.slice(1, -1).replace(/\s+/g, " ").trim())
    // Bare digit samples are `normalizeDigits` internals, not copy.
    .filter((s) => !/^[۰-۹٠-٩\s.,،٬٫-]*$/.test(s));

  if (persian.length) {
    untranslated.push({
      file,
      count: persian.length,
      samples: persian.slice(0, 3).map((s) => (s.length > 56 ? `${s.slice(0, 53)}…` : s)),
    });
  }
}

const orphans = [...used].filter((key) => !faKeys.has(key)).sort();
const missingInEn = [...faKeys.keys()].filter((key) => !enKeys.has(key)).sort();
const enOnly = [...enKeys.keys()].filter((key) => !faKeys.has(key)).sort();
const unused = [...faKeys.keys()].filter((key) => !used.has(key)).sort();

const bullet = (items: string[]) => items.map((i) => `    ${i}`).join("\n");

console.log(`\nlocale keys: ${faKeys.size} fa / ${enKeys.size} en · referenced in code: ${used.size}`);

if (orphans.length) {
  console.log(`\n❌ ${orphans.length} key(s) used in code but missing from fa.json:`);
  console.log(bullet(orphans));
}

if (enOnly.length) {
  console.log(`\n❌ ${enOnly.length} key(s) in en.json with no fa.json counterpart:`);
  console.log(bullet(enOnly));
}

if (missingInEn.length) {
  console.log(`\n⚠️  ${missingInEn.length} key(s) not translated to English (falls back to Persian):`);
  console.log(bullet(missingInEn));
}

if (unused.length) {
  console.log(`\nℹ️  ${unused.length} key(s) defined but never used:`);
  console.log(bullet(unused));
}

if (untranslated.length) {
  const total = untranslated.reduce((sum, f) => sum + f.count, 0);
  console.log(`\nℹ️  ${total} Persian string literal(s) still inline, in ${untranslated.length} file(s):`);
  for (const { file, count, samples } of untranslated.sort((a, b) => b.count - a.count)) {
    console.log(`    ${String(count).padStart(3)}  ${file}`);
    for (const sample of samples) console.log(`         · ${sample}`);
  }
} else {
  console.log("\n✅ no inline Persian string literals left in src/");
}

const fatal = orphans.length + enOnly.length;
console.log(fatal === 0 ? "\n✅ locale files are consistent\n" : `\n❌ ${fatal} problem(s) to fix\n`);
process.exit(fatal === 0 ? 0 : 1);
