# Narnix

A base template for Telegram bots that run on Cloudflare Workers. It is not a finished
product — it is the scaffolding every bot ends up needing anyway: a module system,
i18n, multi-step forms that survive a serverless restart, an admin panel, a
support-ticket system, and a background job runner. You clone it, delete what you do
not want, and add your own feature as one more module.

Built on [grammY](https://grammy.dev), D1 for durable state, KV for sessions, and Cron
Triggers for scheduled work. Everything fits inside the Workers Free plan.

It is aimed at someone starting a new bot who would otherwise spend the first week
rediscovering that KV is eventually consistent, that `@grammyjs/conversations` replays
your handler from the top on every update, and that a broadcast loop cannot finish
inside one invocation's subrequest budget. Those answers are already wired in here, and
the code comments explain why each one is the way it is.

**Getting started: [docs/setup.md](docs/setup.md)** — zero to a running bot, including
the two steps that are easy to miss (forum topic mode in @BotFather, and the
placeholder ids in `wrangler.jsonc`).

## What is in the box

- **Module system.** A feature is a `BotModule`: an id, a grammY `Composer`, and
  optionally a list of wizards. Registered in one place, with load order that is
  documented and enforced. See [Architecture](#architecture).
- **i18n, RTL-aware.** English and Persian. Translation keys are a TypeScript union
  derived from `fa.json`, so a typo is a compile error rather than a raw key printed in
  someone's chat. Enforced by `pnpm check:i18n`.
- **Wizards on a D1 replay log.** `@grammyjs/conversations` v2 with a D1-backed storage
  adapter (not KV — `src/core/conversationStorage.ts` explains why), a 30-minute idle
  timeout, and typed prompt helpers (`askText`, `askInt`, `askChoice`, `confirm`,
  `askPhoto`, `askSecret`) in `src/core/wizard.ts`.
- **Ticket system built on forum topics in private chats.** Each ticket gets a thread
  in the user's chat and a matching thread in the owner's chat, with messages relayed
  between them. Every relayed message is recorded, so a message that arrives while one
  side has minimized their thread is delivered when it reopens instead of being
  dropped. Needs topic mode enabled on the bot — see the setup guide.
- **Admin panel.** User lookup with a balance lever, admin add/remove, and a broadcast
  composer. All of it behind a single `composer.filter(isAdmin)`.
- **Broadcasts that actually finish.** The wizard only queues; a Cron Trigger drains
  the queue 15 recipients at a time, tracking a cursor, and stamps users who have
  blocked the bot so future sends skip them.
- **Channel-lock middleware.** Optional gate requiring channel membership before the
  bot responds. Fails open by default (one constant flips it), because a broken
  membership check should not take the whole bot offline.
- **Language switcher.** Its own module, because it is the one screen that has to work
  before the user can read anything else.
- **Local development without a public URL.** `pnpm poll` runs the real bot in long
  polling mode against your local D1 and KV, so you can iterate without deploying or
  tunnelling.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm poll` | Run the bot locally in long polling mode against local D1/KV. The normal dev loop. |
| `pnpm poll:watch` | Same, restarted on every change under `src/`. |
| `pnpm dev` | `wrangler dev` — the Worker itself. Needs a publicly reachable URL and a webhook to receive updates. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm check:i18n` | Locale audit — see [The i18n contract](#the-i18n-contract). |
| `pnpm smoke:wizards` | Drives every wizard with synthetic updates against local D1. |
| `pnpm db:migrate` | Apply migrations to the local D1. |
| `pnpm db:migrate:remote` | Apply migrations to the real D1. |
| `pnpm db:migrations` | List remote migration state. |
| `pnpm deploy` | `wrangler deploy`. |

The three gates CI runs are `pnpm typecheck`, `pnpm check:i18n`, and
`pnpm smoke:wizards`. Run them before you push.

`pnpm test` exists and runs vitest, but this template ships no test files and CI does
not run it.

## Architecture

```
src/
  index.ts                  fetch (webhook) + scheduled (cron) entry points
  core/
    bot.ts                  builds the bot per request; middleware order lives here
    registry.ts             the module list — where you register your own
    module.ts               the BotModule / ConversationSpec contracts
    conversations.ts        mounts the conversations plugin and every wizard
    conversationStorage.ts  D1 replay-log adapter + CONVERSATION_DATA_VERSION
    wizard.ts               askText / askInt / askChoice / confirm / esc / ...
    env.ts                  which vars are required, and what happens when they are not
    errorHandler.ts, parseMode.ts
  modules/                  one directory per feature
    start/  language/  ticket/  admin/
  middlewares/channelLock.ts
  jobs/                     cron work (the broadcast drain) + reachability helpers
  locales/                  fa.json (source of truth) + en.json
  types/                    Env, context flavors, database row types, i18n key types
  utils/                    i18n, formatting, dates, KV session adapter
migrations/                 numbered .sql files, applied by wrangler
```

Two entry points, both in `src/index.ts`. `fetch` answers Telegram's webhook POSTs (any
other method gets a plain "online" response, which doubles as a health check).
`scheduled` dispatches Cron Triggers to `src/jobs/index.ts`, which branches on
`event.cron` — the literal expression string from `wrangler.jsonc`, matched as text.

### The module system

A module is a plain object:

```ts
export interface BotModule {
  id: string;                          // unique; the registry throws on a collision
  name: string;
  description?: string;
  composer: Composer<MyContext>;       // the module's routes and handlers
  conversations?: ConversationSpec[];  // multi-step forms it owns
}
```

`src/core/registry.ts` holds the list. Registration order is middleware order, and two
positions are not negotiable:

- **`StartModule` first.** It owns `/start`, which upserts the `users` row every other
  module reads. Anything registered ahead of it can run against a user who does not
  exist in D1 yet.
- **`AdminModule` last.** Its composer is filtered to admins and claims broad callback
  patterns. Registered earlier it shadows feature-module handlers — but only for
  accounts that happen to be admins, which means only for yours. That is the hardest
  class of bug to notice.

Your modules go in between. Duplicate module ids and duplicate conversation ids both
throw at construction rather than silently overwriting, because both failures are
invisible at runtime: the only symptom is a handler that is never reached, or the wrong
form opening.

The registry mounts every module's wizards ahead of every module's composer. While a
wizard is active it consumes the update, so an `on("message:text")` handler mounted
first would swallow the user's answer to a form question.

### Adding a module: a worked example

A "notes" feature — a menu button, a list screen, and a wizard that writes a row.

**1. Migration.** A new numbered file; never edit one that has been applied.

```sql
-- migrations/0004_notes.sql
CREATE TABLE IF NOT EXISTS notes
(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER  NOT NULL,
    body       TEXT     NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
```

**2. The module**, in `src/modules/notes/index.ts`:

```ts
import { Composer, InlineKeyboard } from "grammy";
import { BotModule, ConversationSpec } from "../../core/module";
import { MyContext, MyConversation, MyConversationContext } from "../../types/context";
import { askText, esc } from "../../core/wizard";

// A constant, not the function name: bundlers rename functions, and an id that
// changes under minification strands every in-flight conversation.
export const NOTE_ADD_CONVERSATION = "note_add";

async function noteAddWizard(
  conversation: MyConversation,
  ctx: MyConversationContext,
): Promise<void> {
  const body = await askText(conversation, ctx, ctx._("notes.ask_body"), { maxLength: 500 });

  // One `external` for the whole side effect. It receives the *outer* context — the
  // one carrying `env` and `from` — and runs exactly once no matter how many times
  // the conversation replays.
  const saved = await conversation.external(async (outer) => {
    const userId = outer.from?.id;
    if (!userId) return false;

    const result = await outer.env.DB
      .prepare("INSERT INTO notes (user_id, body) VALUES (?, ?)")
      .bind(userId, body)
      .run();

    return result.meta.changes > 0;
  });

  await ctx.reply(ctx._(saved ? "notes.saved" : "notes.save_failed"));
}

const composer = new Composer<MyContext>();

composer.callbackQuery("notes_open", async (ctx) => {
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId) return;

  const rows = await ctx.env.DB
    .prepare("SELECT body FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 10")
    .bind(userId)
    .all<{ body: string }>();

  // `esc` before interpolating user text into an HTML message. A single `<` in a
  // note otherwise turns this screen into a permanent 400.
  const list = rows.results.map((row) => "• " + esc(row.body)).join("\n");

  await ctx.editMessageText(rows.results.length ? list : ctx._("notes.empty"), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text(ctx._("notes.add"), "notes_add").row()
      .text(ctx._("common.back_to_main"), "action_cancel"),
  });
});

composer.callbackQuery("notes_add", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter(NOTE_ADD_CONVERSATION);
});

const noteAddConversation: ConversationSpec = {
  id: NOTE_ADD_CONVERSATION,
  builder: noteAddWizard,
};

export const NotesModule: BotModule = {
  id: "notes",
  name: "Personal Notes",
  composer,
  conversations: [noteAddConversation],
};
```

**3. Register it** in `src/core/registry.ts`, between `StartModule` and `AdminModule`:

```ts
import { NotesModule } from "../modules/notes";
// ...
this.register(StartModule);
this.register(LanguageModule);
this.register(NotesModule);   // <-- here
this.register(TicketModule);
this.register(AdminModule);
```

**4. Add the copy** to both `src/locales/fa.json` and `src/locales/en.json`:

```json
"notes": {
  "add": "New note",
  "ask_body": "Send the text of your note.",
  "button": "My notes",
  "empty": "You have no notes yet.",
  "save_failed": "The note could not be saved. Try again.",
  "saved": "Saved."
}
```

**5. Add the entry point** to the main menu in `src/modules/start/utils.ts` — one
`.text(ctx._("notes.button"), "notes_open")` above the share row. Support and language
stay last: users learn menu positions, and a settings row that moves between releases
is worse than one that is slightly out of the way.

**6. Bump `CONVERSATION_DATA_VERSION`** in `src/core/conversationStorage.ts` if you
edited an *existing* wizard. The plugin replays a wizard's builder function from the
top on every update; if the code changes while someone is halfway through, the
recording and the code disagree and the replay desynchronises. Bumping the version
makes the plugin discard in-flight state instead, which trades "a few users restart a
form" for "no user hits a corrupted replay". A brand-new wizard needs no bump.

**7. Run the gates**: `pnpm db:migrate`, then
`pnpm typecheck && pnpm check:i18n && pnpm smoke:wizards`.

Then add a section to `smoke.wizards.ts` for the new wizard. Its header lists the five
checks worth copying for any wizard — each one is a bug that has actually shipped in a
conversations-based bot.

## The i18n contract

**Every user-facing string lives in `src/locales/*.json`. No inline literals.**

- `fa.json` is the source of truth for the key set. `src/types/i18n.ts` derives
  `TranslationPath` from it as a TypeScript union, so `ctx._("notes.bdoy")` fails to
  compile. There is no code generation step, so the type cannot drift from the JSON.
- `en.json` is allowed to be partial. Any key it omits falls back to Persian, so a
  half-finished translation degrades to mixed language rather than to raw key names.
- Interpolation is `{{name}}` in the JSON, filled by the second argument:
  `ctx._("welcome", { name: esc(firstName) })`.
- Write for whoever *reads* the message, not whoever triggered it. `ctx._` is the
  acting user's language; use `translatorFor(db, userId)` for anything landing in
  someone else's chat — a ticket reply, a broadcast, an admin notification. Getting
  this wrong is invisible to the person who caused it, because the message looks
  correct in the copy they are reading.

`pnpm check:i18n` audits all of it:

- **Fails** on keys used in code but missing from `fa.json` (they render as the raw key
  in a chat), and on keys in `en.json` with no `fa.json` counterpart (almost always a
  typo).
- **Reports without failing**: keys missing from `en.json`, keys defined but never
  used, and any Persian string literal still inline in `src/`, per file. That last one
  is a to-do list rather than an error, so it will not block a work-in-progress branch
  — but a new module should not add to it.

## Using this as a template

Click **Use this template** on GitHub, or
`gh repo create my-bot --template realSamy/narnix`. Then work through
[docs/setup.md](docs/setup.md).

Nothing operator-specific is committed. There is no `vars` block in `wrangler.jsonc`;
the bot token, owner id and channel lock come from `.dev.vars` locally and Worker
secrets in production. The two ids in `wrangler.jsonc` are placeholders you replace
with your own.

Names worth changing: `name` in `wrangler.jsonc` (the Worker name), `database_name`
there *and* in the three `db:*` scripts in `package.json` (the two must match), and
`name`/`description` in `package.json`.

Things you can remove without touching anything else: the channel lock (leave
`CHANNEL_LOCK` unset and it is already inert), the ticket module, or the admin module's
broadcast wizard. Removing a module means deleting its `register()` call, its
directory, and its locale keys — `pnpm check:i18n` lists the orphans it leaves behind.

### Leftovers from the bot this was extracted from

Narnix came out of a working shop bot, and some of that is still here. None of it breaks
anything, and the wallet parts illustrate the shapes the base was built around — but one
of them is *live*, so read this before you ship.

- **A referral bonus that pays out.** `src/modules/start/utils.ts` defines
  `REFERRAL_BONUS = 20000` and `processReferral`, which `showMainMenu` calls on every
  main-menu render to redeem whatever referral code the `/start ref_<id>` deep link left
  in the session. It credits the inviter's balance for real. If your bot has no wallet,
  delete this first — it is the one leftover with a side effect.
- **The wallet itself.** The `balance` column on `users`, `src/utils/balance.ts`
  (`creditBalance`), and the admin panel's balance lever in `src/modules/admin/lookup.ts`
  and `src/modules/admin/wizards/lookup.ts`. A balance is genuinely useful in a bot base;
  keep it if you want one.
- **Toman, hardcoded as the currency.** `toman()` and `money()` in
  `src/utils/format.ts`, over the `common.toman` locale key. Changing currency means
  editing that key in both locale files — the formatter deliberately holds no currency
  string of its own.
- **Dead types.** `Cart`, `CartCoupon`, `panelId` and the `awaiting_receipt` session step
  in `src/types/context.d.ts`. Referenced by nothing outside that file; safe to delete
  outright.
