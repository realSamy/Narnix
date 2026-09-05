/**
 * Layer audit.
 *
 * Run with `pnpm check:layer`. The data layer is a boundary, and a boundary that
 * is only a convention erodes one pull request at a time — someone adds "just
 * one query" to a handler, nothing fails, and six months later the modules read
 * and write tables directly again. This gate makes the boundary mechanical:
 *
 *   **SQL statements may only be prepared inside the data layer**, which is
 *   `src/core/db/**` (the generic `repo()` builder and the shared-entity
 *   repositories) plus each module's own `repo.ts` (its owned tables).
 *
 * Everything else — handlers, wizards, jobs, core utilities — must go through
 * the repository functions. A bespoke query is not forbidden; it is *located*:
 * if a module needs one, it belongs in that module's `repo.ts` with a name and
 * a comment, where it can be read next to its siblings.
 *
 * Exits non-zero on any violation, listing file and line. The check is textual
 * (`prepare(` rather than a real AST) because the rule it enforces is about
 * location, not semantics — the same trade `check:i18n` makes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file's own location, so the audit runs from any working
// directory rather than only from the repository root. (`.href`, not the URL
// object itself: `fileURLToPath` wants Node's URL type.)
const SRC = fileURLToPath(new URL("../src", import.meta.url).href);

/**
 * The one shape to look for. D1 access always starts at `.prepare(` — via
 * `ctx.env.DB`, a bare `db`, or a `repo()` escape hatch — so this catches every
 * real query and nothing else.
 */
const PREPARE = /\.prepare\s*\(/;

/** Paths that are allowed to prepare SQL statements. */
function isDataLayer(path: string): boolean {
  // Compared relative to `src`, so the allowlist reads the same no matter where
  // the audit was invoked from.
  const normalised = path.slice(SRC.length).replace(/\\/g, "/");

  // The generic layer and the shared-entity repositories.
  if (normalised.startsWith("/core/db/")) return true;

  // A module's owned data layer. Naming the file `repo.ts` is the convention;
  // keeping the allowlist to one filename is what keeps the exception legible.
  if (normalised.endsWith("/repo.ts")) return true;

  return false;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return allFiles(path);
    if (!entry.endsWith(".ts")) return [];
    return [path];
  });
}

const violations: string[] = [];

for (const path of allFiles(SRC)) {
  if (isDataLayer(path)) continue;

  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (PREPARE.test(line)) {
      violations.push(`${path}:${index + 1}  ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    "check:layer — SQL found outside the data layer.\n" +
      "Data handlers live in `src/core/db/repositories/` (shared tables) or a\n" +
      "module's own `repo.ts` (owned tables). Move the query there and call it\n" +
      "by name; the boundary is the point.\n",
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("check:layer — no SQL outside the data layer.");
