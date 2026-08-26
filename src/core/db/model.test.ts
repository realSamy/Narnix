// noinspection SqlResolve

import { describe, expect, it } from "vitest";

import { defineModel, repo, Repo } from "./model";

// =============================================================================
// Unit tests for query *construction*.
//
// The repository is a SQL-string builder over D1's bind parameters, so what is
// worth testing is exactly that: the SQL text that comes out and the order of
// the binds that go in. A recording stub answers every statement, which keeps
// the suite off the network, off wrangler, and off any real SQLite — the
// end-to-end behaviour is what `pnpm smoke:wizards` already covers against a
// real local D1.
// =============================================================================

interface Row {
  id: number;
  name: string;
  note: string | null;
  updated_at: string;
}

const Test = defineModel<Row>({
  table: "test",
  key: "id",
  columns: { id: 1, name: 1, note: 1, updated_at: 1 },
});

const Touched = defineModel<Row>({
  table: "test",
  key: "id",
  columns: { id: 1, name: 1, note: 1, updated_at: 1 },
  touch: "updated_at",
});

interface Statement {
  sql: string;
  binds: unknown[];
}

/** A D1 stub that records every (sql, binds) pair it is asked to run. */
function recordingDb(changes = 1): { db: D1Database; queries: Statement[] } {
  const queries: Statement[] = [];

  const makeStmt = (sql: string) => {
    const entry: Statement = { sql, binds: [] };
    const stmt = {
      bind(...binds: unknown[]) {
        entry.binds = binds;
        return stmt;
      },
      async first<R>(): Promise<R | null> {
        queries.push(entry);
        return null;
      },
      async all<R>(): Promise<{ results?: R[] }> {
        queries.push(entry);
        return { results: [] };
      },
      async run(): Promise<D1Result> {
        queries.push(entry);
        // Only `success` and `meta.changes` are ever read by the layer; the rest of
        // D1Meta (timings, row counts) is inert in a recording stub.
        return { success: true, meta: { changes } } as unknown as D1Result;
      },
    };
    return stmt;
  };

  const db = { prepare: (sql: string) => makeStmt(sql) } as unknown as D1Database;
  return { db, queries };
}

function last(queries: Statement[]): Statement {
  expect(queries.length).toBeGreaterThan(0);
  return queries[queries.length - 1];
}

describe("repo() query construction", () => {
  it("builds an equality WHERE with bound values", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Test).getWhere({ id: 7 });

    expect(last(queries).sql).toBe("SELECT * FROM test WHERE id = ?");
    expect(last(queries).binds).toEqual([7]);
  });

  it("maps null to IS NULL, not to a bind", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Test).getWhere({ note: null, name: "x" });

    // `note = NULL` would match nothing — the whole reason this case exists.
    expect(last(queries).sql).toBe("SELECT * FROM test WHERE note IS NULL AND name = ?");
    expect(last(queries).binds).toEqual(["x"]);
  });

  it("maps an array to an IN list and an empty array to 1 = 0", async () => {
    const { db, queries } = recordingDb();
    const r = repo(db, Test);

    await r.all({ id: [1, 2, 3] });
    expect(last(queries).sql).toBe("SELECT * FROM test WHERE (id IN (?, ?, ?))");
    expect(last(queries).binds).toEqual([1, 2, 3]);

    // `IN ()` is a SQLite syntax error; "matches nothing" must stay a valid query.
    await r.all({ id: [] });
    expect(last(queries).sql).toBe("SELECT * FROM test WHERE 1 = 0");
    expect(last(queries).binds).toEqual([]);
  });

  it("inlines order, direction, limit and offset (never bound)", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Test).all({ note: null }, { orderBy: ["id"], orderDir: "desc", limit: 5, offset: 10 });

    expect(last(queries).sql).toBe(
      "SELECT * FROM test WHERE note IS NULL ORDER BY id DESC LIMIT 5 OFFSET 10",
    );
    expect(last(queries).binds).toEqual([]);
  });

  it("rejects a column the model does not declare, before any SQL is built", async () => {
    const { db, queries } = recordingDb();
    const r = repo(db, Test);

    await expect(r.getWhere({ nope: 1 } as never)).rejects.toThrow(/Unknown column "nope"/);
    expect(queries).toHaveLength(0);
  });

  it("builds an upsert with the primary key as conflict target", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Test).upsert({ id: 1, name: "a" });

    expect(last(queries).sql).toBe(
      "INSERT INTO test (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
    );
    expect(last(queries).binds).toEqual([1, "a"]);
  });
});

describe("repo() writes", () => {
  it("insertOrIgnore returns 0 on a conflict and 1 on an insert", async () => {
    const ignored = recordingDb(0);
    expect(await repo(ignored.db, Test).insertOrIgnore({ id: 1, name: "a" })).toBe(0);
    expect(last(ignored.queries).sql).toBe(
      "INSERT INTO test (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );

    const inserted = recordingDb(1);
    expect(await repo(inserted.db, Test).insertOrIgnore({ id: 1, name: "a" })).toBe(1);
  });

  it("insertReturning defaults to RETURNING the primary key", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Test).insertReturning({ name: "a" });

    expect(last(queries).sql).toBe("INSERT INTO test (name) VALUES (?) RETURNING id");
    expect(last(queries).binds).toEqual(["a"]);
  });

  it("updateWhere appends the touch column automatically", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Touched).update(1, { name: "b" });

    expect(last(queries).sql).toBe(
      "UPDATE test SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    );
    expect(last(queries).binds).toEqual(["b", 1]);
  });

  it("updateWhere lets an explicit touch-column value win", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Touched).update(1, { name: "b", updated_at: "2026-01-01 00:00:00" });

    expect(last(queries).sql).toBe(
      "UPDATE test SET name = ?, updated_at = ? WHERE id = ?",
    );
    expect(last(queries).binds).toEqual(["b", "2026-01-01 00:00:00", 1]);
  });

  it("updateWhere does not touch models that declare no touch column", async () => {
    const { db, queries } = recordingDb();
    await repo(db, Test).update(1, { name: "b" });

    expect(last(queries).sql).toBe("UPDATE test SET name = ? WHERE id = ?");
  });

  it("deleteWhere refuses to run without conditions", async () => {
    const { db, queries } = recordingDb();
    await expect(repo(db, Test).deleteWhere({})).rejects.toThrow(/refuses to run/);
    expect(queries).toHaveLength(0);
  });
});

describe("repo() escape hatches", () => {
  it("rawAll returns every row, raw returns the first", async () => {
    const { db, queries } = recordingDb();
    const r: Repo<Row> = repo(db, Test);

    await r.rawAll("SELECT * FROM test WHERE id > ?", 10);
    expect(last(queries).sql).toBe("SELECT * FROM test WHERE id > ?");
    expect(last(queries).binds).toEqual([10]);

    await r.raw("SELECT COUNT(*) AS n FROM test");
    expect(last(queries).sql).toBe("SELECT COUNT(*) AS n FROM test");
  });
});
