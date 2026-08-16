# Setup

Zero to a running bot. Roughly 20 minutes, most of it waiting on Cloudflare and
@BotFather.

Two steps in here are easy to miss and both fail quietly rather than loudly: enabling
forum topic mode for your bot ([step 2](#2-create-the-bot-in-botfather)), and replacing
the placeholder resource ids in `wrangler.jsonc` ([step 3](#3-create-the-d1-database-and-kv-namespace)).

## 1. Prerequisites

- **Node.js 22 or newer.** Wrangler 4 declares `engines: { node: ">=22.0.0" }`. There
  is no `engines` field in this repo's `package.json` pinning it, so nothing will stop
  you on an older Node — it will just fail somewhere less obvious.
- **pnpm.** This project is pnpm-only: `pnpm-lock.yaml` (lockfile format 9.0) and
  `pnpm-workspace.yaml`, which is where the build allowlist for `esbuild`/`workerd`
  lives. `package-lock.json` is gitignored on purpose — a second lockfile installs a
  different tree. Install with `npm i -g pnpm` or `corepack enable pnpm`.
- **A Cloudflare account.** The free plan is enough: Workers, D1, KV and 5 Cron
  Triggers are all included.
- **A Telegram account**, for @BotFather and for being the bot's owner.

```bash
pnpm install
npx wrangler login
```

`wrangler login` opens a browser and stores an OAuth token for your machine. You only
need it for the `--remote` and `deploy` steps; everything local works without it.

## 2. Create the bot in @BotFather

Talk to [@BotFather](https://t.me/BotFather):

1. `/newbot`, then follow the prompts for a display name and a username. It replies
   with a token that looks like `123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. That
   is your `BOT_TOKEN`. Treat it as a password — anyone holding it fully controls the
   bot.
2. **Enable forum topic mode for private chats.** The ticket system in this template
   does not work without it.

### About topic mode

The ticket system does not use an admin supergroup. It opens a forum topic in the
*user's* private chat with the bot and a matching topic in the *owner's* private chat,
then relays messages between the two threads. This relies on private-chat forum topics,
which arrived in Bot API 9.3 (December 31, 2025) and gained `createForumTopic` support
for private chats in 9.4 (February 9, 2026). `createForumTopic` is documented as working
in "a forum supergroup chat **or a private chat with a user**".

Topic mode is off by default and is enabled per bot by its owner. Enable it in
[@BotFather](https://t.me/BotFather) — its newer per-bot toggles live in the BotFather
Mini App (`/mybots`, select your bot, then its settings). **The exact menu wording is
not documented in any official source we could find**, so rather than quote a path that
may be wrong, verify the result directly:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
```

You are looking for `"has_topics_enabled": true` in the response. The Bot API describes
that field as "True, if the bot has forum topic mode enabled in private chats. Returned
only in `getMe`." A related field, `allows_users_to_create_topics` ("True, if the bot
allows users to create and delete topics in private chats"), controls whether *users* may
create or delete topics themselves. The Bot API 9.4 changelog introduces it as allowing
bots to "prevent users from creating and deleting topics in private chats through a new
setting in the @BotFather Mini App" — so it is an opt-*out*, and it is not required for
this bot, which creates the topics itself.

Until `has_topics_enabled` is true, the ticket flow degrades rather than crashing:
`src/modules/ticket/topics.ts` reads the flag off `ctx.me` and, when it is false,
returns `null` instead of attempting a create that would 400. The user is told the
conversation could not be opened (`ticket.topic_open_failed` /
`ticket.created_no_topic`). That is by design — a clean failure beats "topic opened"
followed by silence — but it does mean the ticket system is *not working* if you never
did this step, and nothing will look broken enough to make you go looking.

## 3. Create the D1 database and KV namespace

```bash
npx wrangler d1 create narnix-db
npx wrangler kv namespace create SESSION_KV
```

Each command prints an id. Paste them into `wrangler.jsonc`, replacing the two
placeholders:

| Field in `wrangler.jsonc` | Placeholder to replace | Comes from |
| --- | --- | --- |
| `d1_databases[0].database_id` | `REPLACE_WITH_YOUR_D1_DATABASE_ID` | `wrangler d1 create` |
| `kv_namespaces[0].id` | `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` | `wrangler kv namespace create` |

Leave the `binding` values (`DB`, `SESSION_KV`) alone — the code refers to them by those
names through `src/types/index.d.ts`.

Two other names in that file are yours to change, if you want to:

- `name` — the Worker's name, which becomes part of its `*.workers.dev` hostname.
- `d1_databases[0].database_name` — currently `narnix-db`. **If you rename it, also
  rename it in the three `db:*` scripts in `package.json`**, which pass the database
  *name* (not the binding) to wrangler:

  ```
  "db:migrate":        "wrangler d1 migrations apply narnix-db --local"
  "db:migrate:remote": "wrangler d1 migrations apply narnix-db --remote"
  "db:migrations":     "wrangler d1 migrations list narnix-db --remote"
  ```

  The two must match or the migration scripts will not find the database.

There is deliberately **no `vars` block** in `wrangler.jsonc`. The owner id and channel
lock are configuration specific to one operator, and `vars` is plaintext in a file that
belongs in source control — see the comment in the file itself.

## 4. Secrets

The names are documented in `.dev.vars.example`. Required:

| Name | What it is |
| --- | --- |
| `BOT_TOKEN` | The token @BotFather gave you. |
| `OWNER` | Your numeric Telegram user id, as a string. Super-admin (always an admin, regardless of the `admins` table) and the human side of every support ticket. |

Optional — each one's absence disables a feature rather than breaking the bot:

| Name | What it is |
| --- | --- |
| `CHANNEL_LOCK` | Channel users must join before the bot answers them. A `@username` or numeric id. Leave empty to disable the gate entirely. |
| `CHANNEL_LOCK_LINK` | The invite link shown on the "join first" screen. |
| `LOCAL_PROXY` | SOCKS proxy for reaching Telegram from a network that blocks it. Read only by `src/poll.ts`; never set this in production. |

If you do not know your own user id, message [@userinfobot](https://t.me/userinfobot),
or start your bot and read the id out of `wrangler tail`.

### Locally

```bash
cp .dev.vars.example .dev.vars
```

Then fill in the real values. **`.dev.vars` is gitignored and must never be committed
— it holds a live bot token.** The `.gitignore` covers `.dev.vars` and `.dev.vars.*`
while keeping `.dev.vars.example` tracked, so the template stays in the repo and your
secrets do not. If you ever do commit a token, rotate it immediately with `/token` in
@BotFather; a token in git history is compromised even after you delete the file.

Both `wrangler dev` and `getPlatformProxy()` (used by `src/poll.ts` and by
`smoke.wizards.ts`) read `.dev.vars` automatically.

### In production

Worker secrets, one at a time:

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put OWNER
npx wrangler secret put CHANNEL_LOCK        # only if you want the gate
npx wrangler secret put CHANNEL_LOCK_LINK
```

Each prompts for the value and does not echo it.

A forgotten secret does not throw. `assertEnv` in `src/core/env.ts` logs the exact
missing names at the top of every invocation — `console.error` for required ones,
`console.warn` for optional — and lets the bot keep serving. That is deliberate: a bot
with a broken channel lock is better than one that 500s on every update. The
consequence is that you have to look. Run `npx wrangler tail` after your first deploy
and read the first few lines.

Bindings (`DB`, `SESSION_KV`) are not checked there, because a missing binding is an
error in Cloudflare's own config and fails loudly on first use.

## 5. Apply migrations

```bash
pnpm db:migrate          # local (.wrangler/state — no Cloudflare credentials needed)
pnpm db:migrate:remote   # the real D1
```

`migrations/` currently holds three files:

- `0001_baseline.sql` — users, admins, conversations, broadcasts, tickets,
  ticket_messages, plus their indexes.
- `0002_ticket_message_backlog.sql` — adds `content_type`, `preview` and `delivered_at`
  to `ticket_messages`, plus an index over the undelivered ones. This is what lets a
  message that arrives while the recipient's topic is closed be replayed into the thread
  when it next opens, instead of being announced and then dropped.
- `0003_user_message_style.sql` — adds `simple_messages_at` and `style_hint_at` to
  `users`, backing the `/simple` toggle between rich and plain transcripts.

Conventions, spelled out at the top of `0001`: never edit an applied migration — add a
new numbered file. `wrangler d1 migrations apply` records which files it has run, so
changing a recorded one leaves your local and remote schemas silently divergent.

### Verifying that migrations landed

`wrangler d1 migrations list` is **not** a reliable status check. It prints
`No migrations to apply!` both when everything really is applied *and* when the
migrations bookkeeping table is broken — the two states you most need to tell apart
look identical.

Query the schema instead. To confirm `0001`:

```bash
npx wrangler d1 execute narnix-db --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

`0002` and `0003` both work by `ALTER TABLE ... ADD COLUMN`, so no new table appears and
the query above cannot see them. Ask for the columns by name instead:

```bash
npx wrangler d1 execute narnix-db --local \
  --command "SELECT 'ticket_messages' AS tbl, name FROM pragma_table_info('ticket_messages') WHERE name IN ('content_type','preview','delivered_at') UNION ALL SELECT 'users', name FROM pragma_table_info('users') WHERE name IN ('simple_messages_at','style_hint_at')"
```

Five rows back — three for `0002`, two for `0003` — means both applied. Swap `--local`
for `--remote` to check production.

## 6. Run it

### Locally — long polling

```bash
pnpm poll        # or pnpm poll:watch to restart on changes under src/
```

This is the normal development loop. `src/poll.ts` pulls your local D1 and KV bindings
through `getPlatformProxy()` and runs the real bot — same middleware, same modules — in
long polling mode. No public URL, no tunnel, no webhook. It starts with
`drop_pending_updates: true`, so messages sent while it was down are discarded rather
than replayed at you.

Do not run `pnpm poll` and a deployed webhook against the same bot token at once.
Telegram delivers each update to one of them, so half your messages will vanish into
the other.

`pnpm dev` runs `wrangler dev` instead, which serves the actual Worker. Useful for
testing the Worker runtime itself, but Telegram cannot reach `localhost` — you need a
public URL and a webhook for it to receive anything.

### Deploying

```bash
pnpm deploy
```

Wrangler prints the deployed URL (`https://<name>.<subdomain>.workers.dev`). Visit it
in a browser: a `GET` returns `Narnix Bot Worker Online`, which is a quick check that
the Worker is up before you point Telegram at it.

Then register the webhook:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<name>.<subdomain>.workers.dev"
```

Check it took:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
```

`pending_update_count` climbing along with a `last_error_message` means Telegram is
reaching the Worker but the Worker is failing; `npx wrangler tail` will show why.

One thing to know about the endpoint as shipped: it accepts any POST and does not
verify Telegram's `X-Telegram-Bot-Api-Secret-Token` header, so the URL is the only
thing keeping strangers from injecting updates. The URL is not secret — it is your
`workers.dev` hostname. If that matters for your bot, set a `secret_token` on
`setWebhook` and pass the matching `secretToken` option to `webhookCallback` in
`src/index.ts`.

Cron Triggers are registered by `wrangler deploy` from the `triggers.crons` array. One
expression ships: `* * * * *`, which drains the broadcast queue and is a no-op when
nothing is queued. To exercise it locally, `wrangler dev --test-scheduled` and hit
`/__scheduled`.

## 7. The gates

```bash
pnpm typecheck       # tsc --noEmit
pnpm check:i18n      # locale audit
pnpm smoke:wizards   # drives every wizard against local D1
```

These three are what CI runs (`.github/workflows/ci.yml`). Run them before pushing.

- **`pnpm typecheck`** covers `src/**` only. Note that translation keys are typed, so a
  mistyped `ctx._("...")` key is a compile error here rather than a raw key appearing
  in someone's chat.
- **`pnpm check:i18n`** fails on keys used in code but missing from `fa.json`, and on
  keys in `en.json` with no `fa.json` counterpart. It also *reports*, without failing,
  keys missing from `en.json`, unused keys, and Persian string literals still inline in
  `src/`. Those three are debt reports, not build breakers.
- **`pnpm smoke:wizards`** needs the local database migrated first (`pnpm db:migrate`) —
  it reads and writes real tables in `.wrangler/state`. It does not need `.dev.vars`,
  real credentials, or network access: every Bot API call is answered by a stub and it
  overrides `OWNER` with its own synthetic id. It cleans up the rows it creates.

If `smoke:wizards` fails with an error about a missing table, that is the migration step
you skipped.
