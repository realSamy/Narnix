/**
 * SQLite's own datetime format: `YYYY-MM-DD HH:MM:SS`, always UTC.
 *
 * Every datetime column in this schema is either written by SQLite itself
 * (`DEFAULT CURRENT_TIMESTAMP`) or compared against something that is, and SQLite
 * has no date type — those comparisons are plain string comparisons. An ISO string
 * breaks them: the `T` separator is 0x54 and the space is 0x20, so
 * `'2026-08-24T00:00:00.000Z' > '2026-08-24 23:59:59'` is *true*. That is how a
 * config expiring at midnight tonight looked further away than one expiring
 * tomorrow, and why the expiry-warning query could not use a range predicate at all.
 *
 * Writing this format instead keeps `WHERE expires_at <= datetime('now', '+3 days')`
 * both correct and index-friendly — wrapping the column in `datetime()` to normalise
 * it would have worked too, but at the cost of a full scan on every cron tick.
 */
export function sqlDateTime(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** `now + days` in SQLite datetime format, or `null` for a duration of zero. */
export function sqlDateTimeIn(days: number): string | null {
  if (!days || days <= 0) return null;
  return sqlDateTime(new Date(Date.now() + days * 86400000));
}

/**
 * Turns whatever a datetime column holds into a `Date`.
 *
 * A bare `new Date("2026-08-24 12:00:00")` works in V8 but only through the legacy
 * non-standard parsing path, and it reads the value as *local* time. That happens to
 * be UTC inside a Worker, so nothing was visibly wrong — but the correctness of every
 * date shown to a user rested on the runtime's timezone, which is not a thing worth
 * resting on. Normalising to ISO first makes it explicit.
 */
function toDate(input: Date | string | number): Date {
  if (typeof input !== "string") return new Date(input);

  // `YYYY-MM-DD HH:MM:SS` (SQLite) → `YYYY-MM-DDTHH:MM:SSZ` (ISO, explicit UTC).
  const sqlShape = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  return new Date(sqlShape.test(input) ? `${input.replace(" ", "T")}Z` : input);
}

/**
 * Whole Unix seconds for a datetime column value.
 *
 * For Telegram's `RichTextDateTime` entity, which takes the instant and lets the
 * *reader's* client render it — in their calendar, their timezone, their language.
 * That is something no formatter here can do: `formatShamsiDateTime` below is correct
 * for a Persian reader and wrong for an English one, and the Worker has no idea what
 * timezone either of them is in.
 */
export function unixSeconds(input: Date | string | number = new Date()): number {
  return Math.floor(toDate(input).getTime() / 1000);
}

/**
 * Converts JS Date or ISO string into Shamsi (Jalali) date string (e.g. 1405/02/06)
 */
export function formatShamsiDate(dateInput: Date | string | number): string {
  const date = toDate(dateInput);

  const formatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date);
}

/**
 * Formats full Shamsi date and time string (e.g. 1405/05/06 14:58:30)
 */
export function formatShamsiDateTime(dateInput: Date | string | number = new Date()): string {
  const date = toDate(dateInput);

  const formatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return formatter.format(date);
}
