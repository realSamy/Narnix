// =============================================================================
// Data handlers for the conversation replay log (`conversations`).
//
// The only writer is the storage adapter in `core/conversationStorage.ts`,
// which `@grammyjs/conversations` calls with a key (the chat id) and a JSON
// blob. This table is deliberately in D1 rather than KV: the plugin's
// correctness depends on read-after-write, and KV is eventually consistent —
// replaying a stale log makes steps repeat or side effects fire twice. Do not
// "optimise" these into the session namespace.
// =============================================================================

import { D1Database } from "@cloudflare/workers-types";
import { repo } from "../model";
import { Conversations } from "../models";
import { sqlDateTime } from "../../../utils/date";

/** The replay log for one chat, or null when the chat has no active conversation. */
export async function readConversationState(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await repo(db, Conversations).get(key);
  return row?.data ?? null;
}

/** Writes (or replaces) the replay log for one chat, stamping `updated_at`. */
export async function writeConversationState(
  db: D1Database,
  key: string,
  data: string,
): Promise<void> {
  await repo(db, Conversations).upsert(
    { key, data, updated_at: sqlDateTime() },
    ["data", "updated_at"],
  );
}

/** Forgets a chat's conversation — the plugin calls this when a wizard exits. */
export async function deleteConversationState(db: D1Database, key: string): Promise<void> {
  await repo(db, Conversations).deleteWhere({ key });
}
