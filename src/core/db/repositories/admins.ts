// =============================================================================
// Data handlers for the `admins` table.
//
// The owner is NOT in this table — they come from `env.OWNER`, which is what
// gives the bot an admin before the first migration has ever run. Callers that
// answer "is this user an admin?" combine both sources (see
// `modules/admin/utils.ts#isAdmin`); this file only speaks for the rows.
// =============================================================================

import { D1Database } from "@cloudflare/workers-types";
import { repo } from "../model";
import { Admins } from "../models";

/** Whether a dynamically granted admin row exists for this user. */
export async function hasAdminRow(db: D1Database, userId: number): Promise<boolean> {
  return (await repo(db, Admins).get(userId)) !== null;
}

/** Every dynamically granted admin's user id. The owner is added by the caller. */
export async function listAdminIds(db: D1Database): Promise<number[]> {
  const rows = await repo(db, Admins).all();
  return rows.map((row) => row.user_id);
}

/**
 * Grants admin, reporting whether anything happened.
 *
 * `insertOrIgnore` is the whole trick here: `0` changed rows means the row
 * already existed, which is how the add-wizard tells "promoted" from "already
 * an admin" — two messages that read very differently to the admin who tapped
 * the button.
 */
export async function addAdmin(
  db: D1Database,
  userId: number,
  addedBy: number | null,
): Promise<"added" | "already"> {
  const changes = await repo(db, Admins).insertOrIgnore({
    user_id: userId,
    added_by: addedBy,
  });

  return changes > 0 ? "added" : "already";
}

/** Revokes a dynamically granted admin. Returns whether a row was removed. */
export async function removeAdmin(db: D1Database, userId: number): Promise<boolean> {
  return (await repo(db, Admins).deleteWhere({ user_id: userId })) > 0;
}
