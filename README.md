# Narnix

A base template for Telegram bots on Cloudflare Workers: grammY for the Bot API, D1
for state, KV for sessions, Cron Triggers for background work. Clone it, delete the
parts you do not want, and add your own feature as one more module.

It exists because every bot ends up needing the same awkward pieces, and each one has
a sharp edge that costs a day to find. KV is eventually consistent, so it is the
wrong home for a wizard's replay log. A conversations-based wizard replays its
function from the top on every update, so a naive `Math.random()` fires twice. And a
broadcast loop cannot finish inside one invocation's 50-subrequest budget, no matter
how you size the batches. Those answers are already wired in here, and the comments
say why each one is the way it is.

**Getting started: [docs/setup.md](docs/setup.md)** — zero to a running bot in about
twenty minutes, including the two steps that fail quietly: forum topic mode in
@BotFather, and the placeholder ids in `wrangler.jsonc`.

## What's in the box

- **A module system.** A feature is a `BotModule`: an id, a grammY `Composer`, and
  optionally a list of wizards. Registered in one place, in an order that is
  documented and enforced. [docs/adding-a-module.md](docs/adding-a-module.md) walks
  through a whole feature.
- **i18n with typed keys.** English and Persian. The key set is a TypeScript union
  derived from `fa.json`, so a typo is a compile error rather than a raw key printed
  in someone's chat. Audited by `pnpm check:i18n` — see
  [docs/i18n.md](docs/i18n.md).
- **Wizards that survive a restart.** `@grammyjs/conversations` v2 over a D1 replay
  log (not KV — `src/core/conversationStorage.ts` explains why), a 30-minute idle
  timeout, and typed prompt helpers (`askText`, `askInt`, `askChoice`, `confirm`) in
  `src/core/wizard.ts`.
- **A ticket system on forum topics.** Each ticket is a thread in the user's private
  chat and a matching thread in the owner's, relayed both ways. Every relayed message
  is recorded, so a message sent while one side has minimized their thread is
  delivered when it reopens instead of being dropped. Needs topic mode enabled on
  the bot.
- **An admin panel.** User lookup with a balance lever, admin add and remove, and a
  broadcast composer — all of it behind a single `composer.filter(isAdmin)`.
- **Broadcasts that actually finish.** The wizard only queues a row. A cron trigger
  drains it 15 recipients at a time with a keyset cursor, leases the job so two
  overlapping invocations cannot deliver the same batch twice, and stamps users who
  blocked the bot so future sends skip them.
- **An enforced data layer.** SQL is prepared in exactly two kinds of place:
  `src/core/db/` and a module's own `repo.ts`. `pnpm check:layer` fails the build
  anywhere else.
- **A channel lock.** An optional membership gate that fails open by default,
  because a broken membership check should not take the whole bot offline.
- **Local development without a public URL.** `pnpm poll` runs the real bot in long
  polling mode against your local D1 and KV.

## Quick start

```bash
pnpm install
cp .dev.vars.example .dev.vars   # BOT_TOKEN from @BotFather, your user id as OWNER
pnpm db:migrate                  # the local D1; needs no Cloudflare credentials
pnpm poll                        # the bot, long polling — the normal dev loop
```

The rest — @BotFather's topic-mode toggle, the D1 and KV ids in `wrangler.jsonc`,
Worker secrets, the webhook — is in [docs/setup.md](docs/setup.md), in order.

## How it fits together

```text
src/
  index.ts        webhook (fetch) + cron (scheduled) entry points
  poll.ts         the long-polling entry point, for `pnpm poll`
  core/           bot assembly, module registry, wizard helpers, the data layer
    db/           model.ts (the typed repo() builder), models.ts, repositories/
  modules/        start · language · ticket · admin — one directory per feature
  jobs/           cron work: the broadcast drain
  middlewares/    the channel lock
  types/          env bindings, the context flavor, row types, the key union
  utils/          dates, randomness, formatting, KV sessions, the translator
  locales/        fa.json (source of truth) + en.json
scripts/          the audit harnesses: check.i18n, check.layer, smoke.wizards
migrations/       numbered .sql files, applied by wrangler
```

There are two entry points. `fetch` answers Telegram's webhook POSTs, and any other
method gets a plain 200 that doubles as a health check. `scheduled` dispatches cron
triggers, branching on the literal expression string from `wrangler.jsonc` — add a
job by adding its expression there and a branch in `src/jobs/index.ts`, copying the
string exactly.

A module is a plain object, and registration order is middleware order:

```ts
export const NotesModule: BotModule = {
  id: "notes",              // unique; the registry throws on a collision
  name: "Personal Notes",
  composer,                 // the module's routes and handlers
  conversations: [noteAdd], // multi-step forms it owns
};
```

`StartModule` registers first, because it owns `/start`, which upserts the user row
every other module reads. `AdminModule` registers last: its filtered composer claims
broad callback patterns and would shadow feature-module handlers, but only for
accounts that happen to be admins — the hardest class of bug to notice, because it
only reproduces on your own account. Your modules go in between.

The data layer has one rule: **SQL statements are prepared only inside
`src/core/db/` or a module's own `repo.ts`.** Everything else calls named functions
(`redeemReferral`, `listReachableIdsAfter`) that take `db` first and read like what
they mean. The generic `repo()` builder compiles each helper to exactly one prepared
statement — no joins, no runtime SQL parsing — and its where-language covers the
three predicate shapes this bot actually needs: equality, `IS NULL`, and `IN`.
Anything richer belongs in a repository function, not in a fourth value shape.

## The gates

```bash
pnpm typecheck       # tsc --noEmit over src/, scripts/ and the tests
pnpm check:i18n      # the locale audit
pnpm check:layer     # fails if SQL is prepared outside the data layer
pnpm test            # vitest unit tests
pnpm smoke:wizards   # drives every wizard against the local D1
```

That is the whole CI job (`.github/workflows/ci.yml`). Run them before pushing. None
of them need Cloudflare credentials; `smoke:wizards` wants `pnpm db:migrate` first.

## Decide before you ship

A few things the base keeps on purpose, where the call is yours:

- **The referral payout is off by default.** Sharing an invite link still records
  the inviter, but the balance credit sits behind `CREDIT_REFERRAL_BONUS` in
  `src/modules/start/utils.ts` — one constant to flip if your bot has a wallet.
- **The wallet itself.** A `balance` column, `creditBalance`/`debitBalance`, and the
  admin panel's lever. Useful if you sell anything; delete the lever if you do not.
- **Toman is the currency.** `toman()` and `money()` in `src/utils/format.ts` read
  the `common.toman` locale key, and hold no currency string of their own. Changing
  currency means editing that key in both locale files.
- **Persian is the fallback language.** A Telegram client language the bot does not
  ship copy for lands on `fa`, and `en.json` is allowed to be partial. Flip the
  precedence in `src/utils/i18n.ts` if your bot is English-first.
- **Tickets need topic mode** enabled for the bot in @BotFather. Without it the flow
  degrades with a clear message rather than breaking — which also makes it easy to
  miss that the feature is off.

## Using this as a template

Click **Use this template**, or `gh repo create my-bot --template realSamy/narnix`,
then work through [docs/setup.md](docs/setup.md).

Nothing operator-specific is committed. There is no `vars` block in
`wrangler.jsonc`; the bot token, owner id and channel lock come from `.dev.vars`
locally and Worker secrets in production, and the two ids in `wrangler.jsonc` are
placeholders you replace with your own. Removing a module means deleting its
`register()` call, its directory and its locale keys — `pnpm check:i18n` lists the
orphans it leaves behind.

MIT — see [LICENSE](LICENSE).

