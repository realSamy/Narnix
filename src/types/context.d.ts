import {Context, SessionFlavor} from "grammy";
import {Conversation, ConversationFlavor} from "@grammyjs/conversations";
import {Env} from "./index";
import {CouponType} from "./database";
import {SupportedLanguage, TranslationPath} from "./i18n";

/**
 * Routing modes that genuinely persist across many updates.
 *
 * This used to be a ~40-member union covering every step of every form, checked
 * by prefix in ten separate `on("message:text")` handlers. The linear form flows
 * now live in `@grammyjs/conversations` wizards instead (see
 * `core/module.ts#ConversationSpec`), so what remains is the one mode that is not
 * a sequence: a user parked waiting to upload a payment receipt, which may sit
 * unanswered for hours and must survive a worker restart. That is a state, and
 * the session is the right place for it.
 *
 * `'ticket'` and `'replying_ticket'` are gone too: support conversations happen in
 * forum topics now, addressed by `message_thread_id`, so neither peer is ever
 * "parked" in a ticket.
 *
 * Do not add form steps here. Add a conversation.
 */
type Step =
  'idle'
  | 'awaiting_receipt';

// A coupon that has been validated and attached to the in-progress cart
interface CartCoupon {
  id: number;
  code: string;
  type: CouponType;
  value: number;
}

/**
 * A purchase in progress: which package, which optional locations, which coupon.
 *
 * Renewals use this same cart. `renewConfigId` is the only thing that distinguishes
 * them, and it is read in exactly one place — the branch in `shop_confirm_buy` that
 * chooses between provisioning a new client and updating an existing one. Everything
 * before that point (picking a package, toggling locations, pricing, the coupon, the
 * invoice, the atomic balance deduction) is deliberately identical, because the two
 * bugs this replaced — renewals charging nothing, and renewals silently dropping
 * purchased locations — both came from renewal having its own copy of that logic.
 */
interface Cart {
  packageId: number;
  panelId: number;
  selectedInboundIds: number[];
  coupon?: CartCoupon;

  /**
   * Set when this cart renews an existing `configs` row rather than creating one.
   *
   * Panel-scoped by construction: the config's `email` and `sub_id` are registered
   * on one panel, so a renewal can only offer packages from that same panel and this
   * id always belongs to `panelId`.
   */
  renewConfigId?: number;
}

// Custom session data
interface SessionData {
  /**
   * Display language, cached from `users.lang`.
   *
   * D1 is the durable record; this is a per-session copy so that rendering a
   * screen does not cost a query. `undefined` means "not hydrated yet" — the
   * binder in `core/bot.ts` fills it from the database on the first update of a
   * session, which is also what keeps a language switch made on another device
   * from being overwritten by a stale default here.
   */
  lang?: SupportedLanguage;
  step: Step;

  /** Inviter id captured from a `?start=ref_<id>` deep link, consumed once. */
  referral?: number;

  // --- Card-to-card deposit, in flight ---
  /** The `transactions.id` a pending receipt upload belongs to. */
  activeTransactionId?: string;
  /** Amount chosen on the deposit screen, read back when a gateway is picked. */
  depositAmount?: number;
  cart?: Cart;
}

/**
 * Looks up a dotted translation key, optionally interpolating `{{var}}` slots.
 *
 * The key is the union of paths that actually exist in `locales/fa.json`, not
 * `string`. A missing key does not throw at runtime — `getTranslator` returns the
 * key itself — which means a typo ships as a user-visible `panel.add.name` in the
 * middle of a chat. Typing the parameter turns that into a compile error instead.
 */
export type Translator = (
  path: TranslationPath,
  replacements?: Record<string, string | number>,
) => string;

/**
 * What every handler in this bot shares: the environment bindings and the
 * translator, bound by the middleware in `core/bot.ts`.
 *
 * Kept separate from `MyContext` because conversations build their context
 * objects from scratch and must NOT carry the session or `ctx.conversation` — see
 * `MyConversationContext`.
 */
type BoundContext = Context & {
  _: Translator;
  env: Env;
};

/**
 * The context type for all normal middleware and module handlers.
 *
 * `ConversationFlavor` adds `ctx.conversation`, the control panel used to enter
 * and exit wizards.
 */
export type MyContext = ConversationFlavor<BoundContext & SessionFlavor<SessionData>>;

/**
 * The context type *inside* a conversation.
 *
 * Two deliberate omissions:
 *
 *  - No `SessionFlavor`. A conversation replays its own builder function on every
 *    update; the outside session is not available to it. Read session values with
 *    `conversation.external((ctx) => ctx.session.…)`, which records the result so
 *    the replay sees the same value it saw the first time.
 *  - No `ConversationFlavor`. Conversations cannot be nested, so `ctx.conversation`
 *    does not exist inside one, and declaring it would be a lie the compiler
 *    would happily let you act on.
 *
 * `_` and `env` are injected per conversation via the `plugins` option — see
 * `core/conversations.ts`.
 */
export type MyConversationContext = BoundContext;

/** The `conversation` handle passed as the first argument to every wizard. */
export type MyConversation = Conversation<MyContext, MyConversationContext>;
