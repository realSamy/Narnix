import type { ConversationData, ConversationStorage } from "@grammyjs/conversations";
import type { MyContext } from "../types/context";

/**
 * Bump this whenever a conversation builder function changes in a way that
 * invalidates in-flight state — a step added or removed, a `wait` call moved, an
 * `external` call inserted.
 *
 * The conversations plugin works by *replaying* the builder function from the top
 * on every update, feeding it the recorded updates and recorded results of every
 * side effect. That only works if the code and the recording still agree. If a
 * wizard is edited while someone is halfway through it, the replay desynchronises
 * and the stored state is effectively corrupt.
 *
 * The version is written alongside the state. On a mismatch the plugin discards
 * the state instead of replaying it, so bumping this trades "a handful of users
 * have to restart the wizard they were in" for "no user hits a corrupted replay".
 * That is always the right trade — bump it on every deploy that touches a wizard.
 */
export const CONVERSATION_DATA_VERSION = 1;

/**
 * Persists conversation replay logs in D1.
 *
 * Deliberately **not** KV, even though sessions live there. KV is eventually
 * consistent: a read shortly after a write can legitimately return the previous
 * value. For a session that costs you one dropped keystroke. For a replay log it
 * means the builder function is re-run against a stale recording — the plugin
 * replays a state that has already advanced, and the user sees a step repeat or
 * a side effect fire twice. D1 is backed by a single primary with no read
 * replication configured here, so a read always observes the preceding write.
 *
 * The default storage key (`ctx.chatId`) is used on purpose. The plugin docs warn
 * against custom key functions in serverless environments because of the race
 * they open, and chat-scoped state is the behaviour we want anyway: one active
 * wizard per chat.
 */
export function d1ConversationStorage(
  db: D1Database,
): ConversationStorage<MyContext, ConversationData> {
  return {
    type: "key",
    version: CONVERSATION_DATA_VERSION,
    adapter: {
      async read(key) {
        const row = await db
          .prepare("SELECT data FROM conversations WHERE key = ?")
          .bind(key)
          .first<{ data: string }>();

        if (!row) return undefined;

        try {
          return JSON.parse(row.data);
        } catch {
          // A row we cannot parse is unusable. Returning undefined makes the
          // plugin treat the chat as having no active conversation, which is the
          // recoverable outcome — the alternative is throwing on every single
          // update from this chat until someone clears the row by hand.
          return undefined;
        }
      },

      async write(key, state) {
        await db
          .prepare(
            `INSERT INTO conversations (key, data, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET data       = excluded.data,
                                            updated_at = CURRENT_TIMESTAMP`,
          )
          .bind(key, JSON.stringify(state))
          .run();
      },

      async delete(key) {
        await db.prepare("DELETE FROM conversations WHERE key = ?").bind(key).run();
      },
    },
  };
}
