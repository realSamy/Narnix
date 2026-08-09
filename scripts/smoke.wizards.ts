/**
 * Wizard smoke harness.
 *
 * Drives the real bot — real middleware order, real conversations plugin, real D1
 * — with synthetic updates, while every Bot API call is answered by a stub. This
 * is how the `@grammyjs/conversations` wiring gets verified without a human
 * tapping buttons in Telegram, and in particular how the replay engine is checked
 * for the failure mode that matters: a side effect running twice.
 *
 * Run with `pnpm smoke:wizards`. It writes to the LOCAL D1 only
 * (`.wrangler/state`), and cleans up the rows it creates.
 *
 * The stub is installed via `client.fetch` rather than an API transformer on
 * purpose. Conversations run on their own `Api` instance built with
 * `new Api(protoApi.token, protoApi.options)`, so transformers do not carry over
 * — but `options` does, and `fetch` lives there.
 *
 * ## Adding a section for your own wizard
 *
 * Every section is the same four moves: `await reset()`, feed the updates a user
 * would actually send, then assert on (a) what reached D1 and (b) what the bot said.
 * The five checks worth copying for any new wizard, because each one is a bug that
 * has actually shipped in a conversations-based bot:
 *
 *  1. the row is written **exactly once** (not once per replay),
 *  2. the `conversations` row is **gone** afterwards (a wizard that never exits eats
 *     every later message from that chat),
 *  3. `/cancel` writes nothing,
 *  4. an unrelated command (`/start`) escapes rather than being swallowed,
 *  5. a non-text answer is explained instead of ignored.
 *
 * Assert on a *fragment* of the expected message, never the whole string — these are
 * copy checks, and a full-string comparison turns every wording tweak into a failing
 * test. Where the copy is likely to change at all (the welcome text, which every fork
 * of this base rewrites first), assert on structure instead: see the `/start` section,
 * which looks for the main-menu keyboard rather than for any particular sentence.
 */
import { getPlatformProxy } from "wrangler";
import type { Update } from "grammy/types";

import { createBot } from "../src/core/bot";
import { Env } from "../src/types";

const OWNER_ID = 100000001; // placeholder — the real owner id comes from env.OWNER at runtime
const CHAT_ID = OWNER_ID;

/** The thread id the stubbed `createForumTopic` hands back. */
const TOPIC_ID = 4242;

/** Every Bot API call the bot made, in order. */
const calls: Array<{ method: string; payload: any }> = [];

function stubResult(method: string, payload: any): unknown {
  switch (method) {
    case "getMe":
      return {
        id: 1,
        is_bot: true,
        first_name: "Narnix",
        username: "narnix_smoke_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        // Private-chat forum topics (Bot API 9.3+) are opt-in per bot, and
        // `src/modules/ticket/topics.ts` reads this off `ctx.me` to decide whether
        // creating one is even possible. Without it the ticket wizard would take its
        // degraded "no topic" path here and the topic code would never be exercised.
        has_topics_enabled: true,
      };
    case "getChatMember":
      return { status: "creator", user: { id: OWNER_ID, is_bot: false, first_name: "Owner" } };
    case "createForumTopic":
      return { message_thread_id: TOPIC_ID, name: payload?.name ?? "", icon_color: 0 };
    case "sendMessage":
    case "editMessageText":
      return {
        message_id: 9000 + calls.length,
        date: 0,
        chat: { id: CHAT_ID, type: "private", first_name: "Owner" },
        text: payload?.text ?? "",
      };
    default:
      return true;
  }
}

const stubFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = url.slice(url.lastIndexOf("/") + 1);

  let payload: any = undefined;
  if (typeof init?.body === "string") {
    try {
      payload = JSON.parse(init.body);
    } catch {
      payload = init.body;
    }
  }

  calls.push({ method, payload });

  return new Response(JSON.stringify({ ok: true, result: stubResult(method, payload) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

let updateId = 700000;
let messageId = 100;

function textUpdate(text: string, threadId?: number): Update {
  // Telegram attaches a `bot_command` entity to slash commands, and grammY's
  // `Composer.command()` matches on that entity rather than on the raw text —
  // omitting it here would make `/start` silently unroutable in the harness only.
  const entities = text.startsWith("/")
    ? [{ type: "bot_command" as const, offset: 0, length: text.split(/\s/)[0].length }]
    : undefined;

  return {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private", first_name: "Owner" },
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      text,
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(entities ? { entities } : {}),
    },
  } as Update;
}

/** The service message Telegram sends when a `requestUsers` button is used. */
function usersSharedUpdate(userId: number): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private", first_name: "Owner" },
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      users_shared: { request_id: 1, users: [{ user_id: userId, first_name: "Picked" }] },
    },
  } as Update;
}

function callbackUpdate(data: string): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: `cb${++messageId}`,
      chat_instance: "1",
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      data,
      message: {
        message_id: ++messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "private", first_name: "Owner" },
        text: "menu",
      },
    },
  } as Update;
}

function stickerUpdate(): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private", first_name: "Owner" },
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      sticker: {
        file_id: "x",
        file_unique_id: "x",
        type: "regular",
        width: 1,
        height: 1,
        is_animated: false,
        is_video: false,
      },
    },
  } as Update;
}

// --- tiny assertion helpers -------------------------------------------------

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}`);
    if (detail !== undefined) console.log("     ", detail);
  }
}

function sentTexts(): string[] {
  return calls
    .filter((c) => c.method === "sendMessage")
    .map((c) => String(c.payload?.text ?? ""));
}

/** Texts of every `editMessageText`, i.e. the screens that replace a menu in place. */
function editedTexts(): string[] {
  return calls
    .filter((c) => c.method === "editMessageText")
    .map((c) => String(c.payload?.text ?? ""));
}

/** Serialised `reply_markup` of every message sent, for asserting on keyboards. */
function sentMarkups(): string[] {
  return calls
    .filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
    .map((c) => JSON.stringify(c.payload?.reply_markup ?? null));
}

function callsTo(method: string): Array<{ method: string; payload: any }> {
  return calls.filter((c) => c.method === method);
}

async function main() {
  const { env: rawEnv, dispose } = await getPlatformProxy();
  const env = rawEnv as unknown as Env;

  // The acting user has to *be* the owner — most wizards exercised below are behind the
  // admin guard, which compares against `env.OWNER`. That value comes from `.dev.vars`,
  // so pinning it to the harness's own id is what keeps these checks independent of whose
  // machine they run on: otherwise they pass only where `OWNER_ID` happens to equal the
  // local operator's real Telegram id, and everyone else sees every check fail with a
  // permission refusal that looks exactly like a wizard bug.
  env.OWNER = String(OWNER_ID);

  const bot = createBot("123:STUB", env, { client: { fetch: stubFetch } });
  await bot.init();

  const db = env.DB;
  const PICKED_ADMIN = 555000111;
  const TARGET_USER = 555000222;
  const SUBJECT = "SMOKE_SUBJECT";
  const BROADCAST_BODY = "SMOKE_BROADCAST_BODY";

  const reset = async () => {
    // The acting user has to exist before anything else: every check below drives an
    // update *from* this id, and the wizards read the row back for language and balance.
    // Seeded here rather than assumed, so the harness passes on a freshly migrated
    // database instead of only on one that happens to have been used by hand.
    await db
      .prepare("INSERT OR IGNORE INTO users (id, first_name, lang) VALUES (?, ?, 'fa')")
      .bind(OWNER_ID, "Owner")
      .run();
    await db
      .prepare("INSERT OR IGNORE INTO users (id, first_name, lang) VALUES (?, ?, 'fa')")
      .bind(TARGET_USER, "Target")
      .run();

    // `ticket_messages` is deleted explicitly rather than left to the foreign key:
    // SQLite only honours `ON DELETE CASCADE` when `PRAGMA foreign_keys` is on, which is
    // a per-connection setting and not something a test should depend on.
    await db
      .prepare("DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id = ?)")
      .bind(OWNER_ID)
      .run();
    await db.prepare("DELETE FROM tickets WHERE user_id = ?").bind(OWNER_ID).run();
    await db.prepare("DELETE FROM broadcasts WHERE created_by = ?").bind(OWNER_ID).run();
    await db.prepare("DELETE FROM admins WHERE user_id = ?").bind(PICKED_ADMIN).run();
    await db.prepare("UPDATE users SET balance = 0 WHERE id IN (?, ?)").bind(OWNER_ID, TARGET_USER).run();
    await db.prepare("DELETE FROM conversations WHERE key = ?").bind(String(CHAT_ID)).run();
    await env.SESSION_KV.delete(String(CHAT_ID));
    calls.length = 0;
  };

  const conversationRows = async () =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM conversations WHERE key = ?")
        .bind(String(CHAT_ID))
        .first<{ n: number }>()
    )?.n ?? -1;

  const ticketCount = async () =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ?")
        .bind(OWNER_ID)
        .first<{ n: number }>()
    )?.n ?? -1;

  const latestTicket = async () =>
    await db
      .prepare("SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 1")
      .bind(OWNER_ID)
      .first<any>();

  const adminCount = async () =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM admins WHERE user_id = ?")
        .bind(PICKED_ADMIN)
        .first<{ n: number }>()
    )?.n ?? -1;

  const balanceOf = async (userId: number) =>
    (
      await db
        .prepare("SELECT balance FROM users WHERE id = ?")
        .bind(userId)
        .first<{ balance: number }>()
    )?.balance ?? -1;

  const liveBroadcasts = async () =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM broadcasts WHERE created_by = ? AND status = 'queued'")
        .bind(OWNER_ID)
        .first<{ n: number }>()
    )?.n ?? -1;

  // === 1. happy path: one ticket, one topic, one confirmation ================
  console.log("\n▶ ticket wizard: happy path");
  await reset();

  await bot.handleUpdate(callbackUpdate("user_support"));
  check("conversation persisted after enter", (await conversationRows()) === 1);

  // The subject shares a 128-character topic title with `#<id>: `, so it is capped at
  // 100. A subject over the cap used to be accepted and then produce a title Telegram
  // rejected, leaving the ticket with no thread at all.
  await bot.handleUpdate(textUpdate("ط".repeat(120)));
  check(
    "over-long subject rejected",
    sentTexts().some((t) => t.includes("طولانی است")),
    sentTexts(),
  );
  check("nothing written while the subject is invalid", (await ticketCount()) === 0);

  await bot.handleUpdate(textUpdate(SUBJECT));

  const ticket = await latestTicket();
  check("ticket inserted exactly once", (await ticketCount()) === 1, await ticketCount());
  check("subject stored verbatim", ticket?.subject === SUBJECT, ticket?.subject);
  check("ticket opens awaiting the owner", ticket?.status === "pending_admin", ticket?.status);
  check("forum topic created exactly once", callsTo("createForumTopic").length === 1);
  check("thread id persisted", ticket?.user_topic_id === TOPIC_ID, ticket?.user_topic_id);
  check("conversation cleaned up on completion", (await conversationRows()) === 0);
  check(
    "user told the topic is open",
    sentTexts().some((t) => t.includes("تیکت شما ایجاد شد")),
    sentTexts(),
  );
  check(
    "owner notified, with the subject",
    sentTexts().some((t) => t.includes("تیکت جدید") && t.includes(SUBJECT)),
    sentTexts(),
  );

  // === 2. a further message must NOT be eaten by the finished wizard ========
  console.log("\n▶ ticket wizard: no leaked step state");
  calls.length = 0;
  await bot.handleUpdate(textUpdate("سلام"));
  check(
    "plain text after completion is not treated as form input",
    (await ticketCount()) === 1 && !sentTexts().some((t) => t.includes("موضوع یا شرح مختصر")),
    sentTexts(),
  );

  // === 3. an open ticket is reused, never duplicated ========================
  console.log("\n▶ ticket wizard: existing open ticket");
  calls.length = 0;
  await bot.handleUpdate(callbackUpdate("user_support"));

  check("no second ticket created", (await ticketCount()) === 1);
  check("no wizard entered", (await conversationRows()) === 0);
  check(
    "the open ticket is shown instead",
    editedTexts().some((t) => t.includes(SUBJECT)),
    editedTexts(),
  );

  // === 4. a threaded message with no ticket behind it is answered ============
  console.log("\n▶ ticket relay: unlinked topic");
  calls.length = 0;
  await bot.handleUpdate(textUpdate("سلام", 9999));
  check(
    "message in an unknown thread gets an explanation, not silence",
    sentTexts().some((t) => t.includes("به هیچ تیکت بازی متصل نیست")),
    sentTexts(),
  );

  // === 5. /cancel aborts without writing ===================================
  console.log("\n▶ ticket wizard: /cancel");
  await reset();

  await bot.handleUpdate(callbackUpdate("user_support"));
  await bot.handleUpdate(textUpdate("/cancel"));

  check("nothing inserted", (await ticketCount()) === 0);
  check("conversation removed", (await conversationRows()) === 0);
  check(
    "cancellation acknowledged",
    sentTexts().some((t) => t.includes("لغو شد")),
    sentTexts(),
  );

  // === 6. an unrelated command escapes the wizard ===========================
  console.log("\n▶ ticket wizard: /start escape hatch");
  await reset();

  await bot.handleUpdate(callbackUpdate("user_support"));
  await bot.handleUpdate(textUpdate("/start"));

  check("nothing inserted", (await ticketCount()) === 0);
  check("conversation removed", (await conversationRows()) === 0);
  // Asserted on the keyboard rather than the welcome copy: the welcome text is the
  // first thing a fork of this base rewrites, and a check that breaks when it does
  // would be teaching the wrong lesson.
  check(
    "downstream handler ran (main menu sent)",
    sentMarkups().some((m) => m.includes("user_support")),
    sentMarkups(),
  );

  // === 7. a non-text message is explained, not swallowed ===================
  console.log("\n▶ ticket wizard: non-text answer");
  await reset();

  await bot.handleUpdate(callbackUpdate("user_support"));
  calls.length = 0;
  await bot.handleUpdate(stickerUpdate());

  check(
    "non-text answer explained",
    sentTexts().some((t) => t.includes("به صورت متن")),
    sentTexts(),
  );
  check("still waiting for the subject", (await conversationRows()) === 1);

  // === 8. admin wizard: the answer arrives as a service message =============
  console.log("\n▶ admin wizard: users_shared");
  await reset();

  await bot.handleUpdate(callbackUpdate("admin_add_start"));
  await bot.handleUpdate(usersSharedUpdate(PICKED_ADMIN));

  check("picked user promoted", (await adminCount()) === 1);
  check(
    "promotion confirmed",
    sentTexts().some((t) => t.includes("اضافه شد")),
    sentTexts(),
  );

  calls.length = 0;
  await bot.handleUpdate(callbackUpdate("admin_add_start"));
  await bot.handleUpdate(usersSharedUpdate(PICKED_ADMIN));

  check("re-adding does not duplicate", (await adminCount()) === 1);
  check(
    "re-adding reports 'already an admin'",
    sentTexts().some((t) => t.includes("از قبل")),
    sentTexts(),
  );

  // === 9. broadcast wizard: a queued row, and only ever one live ============
  console.log("\n▶ broadcast wizard: queue");
  await reset();

  await bot.handleUpdate(callbackUpdate("admin_broadcast"));
  await bot.handleUpdate(textUpdate(BROADCAST_BODY));

  // Markup is validated by really sending the body back to its author, so the preview
  // has to appear before the confirmation is asked for.
  check(
    "body previewed to its author",
    sentTexts().some((t) => t.includes(BROADCAST_BODY)),
    sentTexts(),
  );
  check("nothing queued before confirmation", (await liveBroadcasts()) === 0);

  await bot.handleUpdate(callbackUpdate("wizard_pick:0")); // ✅ yes

  const job = await db
    .prepare("SELECT * FROM broadcasts WHERE created_by = ? ORDER BY id DESC LIMIT 1")
    .bind(OWNER_ID)
    .first<any>();

  check("broadcast queued exactly once", (await liveBroadcasts()) === 1, await liveBroadcasts());
  check("body stored verbatim", job?.message === BROADCAST_BODY, job?.message);
  check("cursor starts before the first user", job?.cursor_user_id === 0, job?.cursor_user_id);
  check("conversation cleaned up", (await conversationRows()) === 0);
  check(
    "queueing confirmed",
    sentTexts().some((t) => t.includes("در صف قرار گرفت")),
    sentTexts(),
  );

  console.log("\n▶ broadcast wizard: second live broadcast refused");
  calls.length = 0;
  await bot.handleUpdate(callbackUpdate("admin_broadcast"));

  check(
    "a second broadcast is refused while one is live",
    sentTexts().some((t) => t.includes("در حال ارسال است")),
    sentTexts(),
  );
  check("still only one queued row", (await liveBroadcasts()) === 1);
  check("no wizard left waiting for a body", (await conversationRows()) === 0);

  // === 10. balance adjust: a confirmed, once-only, notified write ============
  //
  // The most load-bearing section here: it is the only wizard in the base that moves
  // money, and it covers `normalizeDigits`, `confirm()`, and — the reason this harness
  // exists — a `conversation.external()` side effect running exactly once across replays.
  console.log("\n▶ admin adjust: credit");
  await reset();

  await bot.handleUpdate(callbackUpdate(`admin_user_adjust:${TARGET_USER}`));
  check("conversation persisted after enter", (await conversationRows()) === 1);

  await bot.handleUpdate(textUpdate("0")); // zero is not an adjustment
  check(
    "a zero delta is refused",
    sentTexts().some((t) => t.includes("صفر")),
    sentTexts(),
  );

  // Persian digits with the grouping separator a Persian keyboard actually produces.
  await bot.handleUpdate(textUpdate("۵۰٬۰۰۰"));
  check("nothing moved before confirmation", (await balanceOf(TARGET_USER)) === 0);

  calls.length = 0;
  await bot.handleUpdate(callbackUpdate("wizard_pick:0")); // ✅ yes

  check(
    "credited exactly once, with digits normalised",
    (await balanceOf(TARGET_USER)) === 50000,
    await balanceOf(TARGET_USER),
  );
  check("conversation cleaned up", (await conversationRows()) === 0);
  check(
    "the target user is told their balance moved",
    callsTo("sendMessage").some((c) => Number(c.payload?.chat_id) === TARGET_USER),
    callsTo("sendMessage").map((c) => c.payload?.chat_id),
  );
  check(
    "admin sees the new figure",
    sentTexts().some((t) => t.includes("اصلاح شد")),
    sentTexts(),
  );

  console.log("\n▶ admin adjust: debit past zero is refused");
  calls.length = 0;

  await bot.handleUpdate(callbackUpdate(`admin_user_adjust:${TARGET_USER}`));
  await bot.handleUpdate(textUpdate("-999999"));
  await bot.handleUpdate(callbackUpdate("wizard_pick:0")); // ✅ yes

  check("balance unchanged", (await balanceOf(TARGET_USER)) === 50000, await balanceOf(TARGET_USER));
  check(
    "the admin is told why",
    sentTexts().some((t) => t.includes("منفی می‌کند")),
    sentTexts(),
  );

  console.log("\n▶ admin adjust: declining at the confirmation writes nothing");
  calls.length = 0;

  await bot.handleUpdate(callbackUpdate(`admin_user_adjust:${TARGET_USER}`));
  await bot.handleUpdate(textUpdate("-10000"));
  await bot.handleUpdate(callbackUpdate("wizard_pick:1")); // ❌ no

  check("balance unchanged", (await balanceOf(TARGET_USER)) === 50000, await balanceOf(TARGET_USER));
  check("conversation cleaned up", (await conversationRows()) === 0);
  check(
    "cancellation acknowledged",
    sentTexts().some((t) => t.includes("لغو شد")),
    sentTexts(),
  );

  await reset();
  await dispose();

  console.log(failures === 0 ? "\n✅ all wizard checks passed\n" : `\n❌ ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
