# Adding a module

A complete feature, end to end: a "notes" module with a menu button, a list screen,
and a wizard that writes a row. Every step below is one the compiler or one of the
gates will ask for, in roughly this order.

**1. Migration.** A new numbered file; never edit one that has been applied. (The
next free number here is `0005` — `0004` is taken by the broadcast lease.)

```sql
-- migrations/0005_notes.sql
CREATE TABLE IF NOT EXISTS notes
(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER  NOT NULL,
    body       TEXT     NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
```

**2. The row type and the model.** `Note` in `src/types/database.d.ts`, then the model
in `src/core/db/models.ts` — the `columns` record must list every column, so the two
cannot drift:

```ts
// types/database.d.ts
export interface Note {
  id: number;
  user_id: number;
  body: string;
  created_at: string;
}

// core/db/models.ts
export const Notes = defineModel<Note>({
  table: "notes",
  key: "id",
  columns: { id: 1, user_id: 1, body: 1, created_at: 1 },
});
```

**3. The module's data handlers**, in `src/modules/notes/repo.ts`. The table belongs to
this module alone, so its queries live here and nowhere else — `pnpm check:layer`
fails the build if SQL turns up in `index.ts`:

```ts
// modules/notes/repo.ts
import { D1Database } from "@cloudflare/workers-types";
import { repo } from "../../core/db/model";
import { Notes } from "../../core/db/models";
import { Note } from "../../types/database";

/** Persists one note. Returns whether the row landed. */
export async function createNote(
  db: D1Database,
  userId: number,
  body: string,
): Promise<boolean> {
  return (await repo(db, Notes).insert({ user_id: userId, body })).meta.changes > 0;
}

/** The user's ten newest notes, newest first. */
export function recentNotes(db: D1Database, userId: number): Promise<Note[]> {
  return repo(db, Notes).all({ user_id: userId }, { orderBy: ["id"], orderDir: "desc", limit: 10 });
}
```

**4. The module**, in `src/modules/notes/index.ts` — handlers, no SQL:

```ts
import { Composer, InlineKeyboard } from "grammy";
import { BotModule, ConversationSpec } from "../../core/module";
import { MyContext, MyConversation, MyConversationContext } from "../../types/context";
import { askText, esc } from "../../core/wizard";
import { createNote, recentNotes } from "./repo";

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
    return userId ? createNote(outer.env.DB, userId, body) : false;
  });

  await ctx.reply(ctx._(saved ? "notes.saved" : "notes.save_failed"));
}

const composer = new Composer<MyContext>();

composer.callbackQuery("notes_open", async (ctx) => {
  await ctx.answerCallbackQuery();

  const userId = ctx.from?.id;
  if (!userId) return;

  const rows = await recentNotes(ctx.env.DB, userId);

  // `esc` before interpolating user text into an HTML message. A single `<` in a
  // note otherwise turns this screen into a permanent 400.
  const list = rows.map((row) => "• " + esc(row.body)).join("\n");

  await ctx.editMessageText(rows.length ? list : ctx._("notes.empty"), {
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

**5. Register it** in `src/core/registry.ts`, between `StartModule` and `AdminModule`:

```ts
import { NotesModule } from "../modules/notes";
// ...
this.register(StartModule);
this.register(LanguageModule);
this.register(NotesModule);   // <-- here
this.register(TicketModule);
this.register(AdminModule);
```

**6. Add the copy** to both `src/locales/fa.json` and `src/locales/en.json`:

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

**7. Add the entry point** to the main menu in `src/modules/start/utils.ts` — one
`.text(ctx._("notes.button"), "notes_open")` above the share row. Support and language
stay last: users learn menu positions, and a settings row that moves between releases
is worse than one that is slightly out of the way.

**8. Bump `CONVERSATION_DATA_VERSION`** in `src/core/conversationStorage.ts` if you
edited an *existing* wizard. The plugin replays a wizard's builder function from the
top on every update; if the code changes while someone is halfway through, the
recording and the code disagree and the replay desynchronises. Bumping the version
makes the plugin discard in-flight state instead, which trades "a few users restart a
form" for "no user hits a corrupted replay". A brand-new wizard needs no bump.

**9. Run the gates**: `pnpm db:migrate`, then
`pnpm typecheck && pnpm check:i18n && pnpm smoke:wizards`.

Then add a section to `scripts/smoke.wizards.ts` for the new wizard. Its header lists
the five checks worth copying for any wizard — each one is a bug that has actually
shipped in a conversations-based bot.
