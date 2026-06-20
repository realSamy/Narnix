import { Translator } from "../types/context";

/**
 * Formats a currency amount for display.
 *
 * Zero means "free" rather than `0 تومان`, because every price in a bot like this has a
 * legitimate zero case — a free trial, a fully-discounted item, a no-cost tier — and
 * "0 Toman" reads like a bug to whoever is looking at it.
 *
 * The currency lives in the `common.toman` locale key, not here, so switching currency is
 * a locale edit in every language file plus a rename of that key — this function and its
 * callers do not need to change. The grouping comes from `toLocaleString()` with no locale
 * argument, matching whatever default the Worker runtime resolves.
 */
export function money(_: Translator, amount: number): string {
  return amount > 0 ? _("common.toman", { amount: amount.toLocaleString() }) : _("common.free");
}

/** Formats an amount without the free special-case, for balances and receipts. */
export function toman(_: Translator, amount: number): string {
  return _("common.toman", { amount: amount.toLocaleString() });
}

/** The 🟢/🔴 dot used in every admin list row. */
export function statusDot(isActive: unknown): string {
  return isActive ? "🟢" : "🔴";
}
