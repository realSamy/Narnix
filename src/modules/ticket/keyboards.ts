import { InlineKeyboard } from "grammy";
import { Translator } from "../../types/context";

/**
 * Every builder here takes the translator of whoever will *read* the buttons, not of
 * whoever triggered the action. A ticket has two sides, and the owner's controls and
 * the user's controls are frequently rendered in the same request.
 */

/** Minimize / close, shown under the header inside the user's own topic. */
export function buildUserTopicControls(_: Translator, ticketId: number): InlineKeyboard {
  return new InlineKeyboard()
      .text(_("ticket.minimize_button"), `t_min_u:${ticketId}`)
      .text(_("ticket.close_button"), `t_close:${ticketId}`);
}

/** The same pair inside the owner's topic — `t_min_o` minimizes the owner's side only. */
export function buildOwnerTopicControls(_: Translator, ticketId: number): InlineKeyboard {
  return new InlineKeyboard()
      .text(_("ticket.minimize_button"), `t_min_o:${ticketId}`)
      .text(_("ticket.close_button"), `t_close:${ticketId}`);
}

/** Attached to the "new ticket" / "new message" notices in the owner's main chat. */
export function buildOwnerNotificationKeyboard(_: Translator, ticketId: number): InlineKeyboard {
  return new InlineKeyboard().text(_("ticket.open_and_reply_button"), `t_open_o:${ticketId}`);
}

/** Shown when a user opens support and already has a ticket in flight. */
export function buildActiveTicketMenu(_: Translator, ticketId: number): InlineKeyboard {
  return new InlineKeyboard()
      .text(_("ticket.open_topic_menu_button"), `t_open_u:${ticketId}`)
      .row()
      .text(_("ticket.close_menu_button"), `t_close:${ticketId}`)
      .row()
      // `action_cancel`, not `main_menu`: nothing has ever registered a `main_menu`
      // callback, so this button did nothing at all.
      .text(_("common.back"), "action_cancel");
}

/**
 * The one-time offer to drop rich formatting, and its reverse.
 *
 * `1` turns simple mode on, `0` turns it back off, so one handler covers both and the
 * button a reader is looking at always says what will happen rather than what is
 * currently true.
 *
 * This keyboard is deliberately attached to a *plain* message. Its whole purpose is to
 * be reachable by someone whose client could not draw the rich message it refers to,
 * and a keyboard is no use to them if it arrives on the message they cannot see.
 */
export function buildMessageStyleKeyboard(_: Translator, simple: boolean): InlineKeyboard {
  return simple
      ? new InlineKeyboard().text(_("ticket.style_rich_button"), "t_simple:0")
      : new InlineKeyboard().text(_("ticket.style_simple_button"), "t_simple:1");
}