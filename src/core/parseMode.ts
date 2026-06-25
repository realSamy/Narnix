import type { Transformer } from "grammy";

/**
 * Methods whose payload carries formatted text.
 *
 * `sendMediaGroup` and `sendPoll` are deliberately absent: their formatting lives
 * on nested objects, not on a top-level `parse_mode`.
 */
const FORMATTED_METHODS = new Set([
  "sendMessage",
  "editMessageText",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "editMessageCaption",
]);

/**
 * Defaults `parse_mode` to Markdown so handlers can use `*bold*` without
 * repeating the option on every call. An explicit `parse_mode` in the payload
 * still wins.
 *
 * Shared between the outer bot and every conversation. Conversations need it
 * separately because the plugin builds each one a *fresh* `Api` instance
 * (`plugin.js#hydrateContext`) which does not inherit `bot.api.config` — without
 * this, markup inside a wizard would render as literal asterisks.
 */
export const defaultParseMode: Transformer = (prev, method, payload, signal) => {
  if (FORMATTED_METHODS.has(method)) {
    payload = { parse_mode: "Markdown", ...payload };
  }

  return prev(method, payload, signal);
};
