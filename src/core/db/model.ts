// =============================================================================
// Typed table models for D1 — a lightweight "Django Models"-flavoured data layer.
//
// ## Design goals and constraints
//
//  - **No runtime overhead.** Every helper compiles down to exactly one D1
//    prepared statement — the same cost as the hand-written
//    `.prepare("SELECT ...").bind(...)` this codebase already uses. There is no
//    schema introspection, no connection pooling to amortise (D1 has none), and
//    rows come back as plain objects (`first<T>()`), never instantiated.
//  - **Injection safety.** All *values* are passed through D1's bind parameters,
//    never interpolated into the SQL string. The only identifiers that reach the
//    SQL text — table and column names — come from the model's own `columns`
//    declaration and are verified against it (see `assertColumn` below); an
//    unknown name throws instead of being concatenated. Nothing a user controls
//    ever becomes part of the SQL text.
//  - **Compile-time safety.** `defineModel`'s `columns` record must name every
//    column of the row type, so a new column added to `types/database.d.ts`
//    without updating the model (or vice versa) is a compile error — the same
//    drift migration 0002 had to reconcile, caught by `tsc` instead.
//
// ## What this layer deliberately does NOT do
//
//  - **Joins.** JOINs stay hand-written SQL; they are one-off, read best as SQL,
//    and a join builder would add nothing but indirection. Use `raw()` when a
//    query is genuinely bespoke.
//  - **Rich predicates.** `WHERE` supports equality, `IS NULL` and `IN` — the
//    three shapes this bot actually needs. `OR`, `LIKE`, range comparisons and
//    subqueries stay in `raw()` SQL rather than growing a condition DSL; the
//    moment one is needed twice, it belongs in a repository function with a
//    name, not in a fourth value shape here.
//  - **Migrations.** Schema lives in `migrations/*.sql` under wrangler's runner,
//    not here.
//  - **Transactions.** D1 has no interactive transactions; multi-statement
//    consistency is handled with conditional writes (`updateWhere` returns the
//    number of rows changed, which is what makes claim-style operations atomic)
//    and explicit compensation in the callers, as the shop's refund path does.
//
// Free plan note: Workers Free caps CPU at 10 ms per invocation. Nothing here
// parses SQL or builds plans at runtime — the string concatenation below is on
// constant, pre-validated names only.
// =============================================================================

/**
 * A datetime column that records a row's last modification, written by SQLite
 * itself (`CURRENT_TIMESTAMP`). When a model declares one, every update through
 * this layer bumps it automatically unless the caller sets it explicitly.
 */
export type TouchColumn = "updated_at";

/** A model definition: the table name plus its declared column set. */
export interface Model<T> {
  table: string;
  /** The primary key column. */
  key: keyof T & string;
  /**
   * Every column this model knows about, mapped to `1`. Written out by hand
   * purely so the exhaustiveness check below can work; it carries no values.
   */
  columns: { [K in keyof T & string]: 1 };
  /**
   * Auto-bumped to `CURRENT_TIMESTAMP` by `update()` / `updateWhere()`.
   *
   * The tickets table was the motivation: five hand-written UPDATEs each had to
   * remember `updated_at = CURRENT_TIMESTAMP`, and the sixth hand-written one
   * was going to forget. Declaring it here puts the bookkeeping in the one
   * place every write already goes through.
   */
  touch?: TouchColumn;
}

/**
 * One condition value in a `where` object.
 *
 *  - a plain value → `c = ?` (bound)
 *  - `null` → `c IS NULL` — because `c = NULL` matches nothing in SQL, and a
 *    naive `where: { blocked_at: null }` would otherwise silently select no
 *    rows at all
 *  - an array → `c IN (?, …)`; an empty array produces `1 = 0`, which matches
 *    nothing while keeping the query valid
 */
export type WhereValue<V> = V | readonly V[] | null;

/** Conditions for reads and writes: every key must be a declared column. */
export type Where<T> = { [K in keyof T]?: WhereValue<T[K]> };

/**
 * Declares a model. Returns the definition unchanged; the type parameters are
 * what do the work — `columns` must list *every* column of `T` and nothing else.
 */
export function defineModel<T>(model: Model<T>): Model<T> {
  return model;
}

// =============================================================================
// Identifier safety
// =============================================================================

/**
 * Rejects any column name the model does not declare.
 *
 * Identifiers cannot be bound parameters in SQL, so every helper routes column
 * names through here before they touch the query text. Unknown names throw
 * immediately — a typo fails loudly at the call site rather than shipping as a
 * broken query.
 */
function assertColumn<T>(model: Model<T>, column: string): string {
  if (!(column in model.columns)) {
    throw new Error(
      `Unknown column "${column}" for table "${model.table}". ` +
        `Add it to the model definition in core/db/models.ts.`,
    );
  }
  return column;
}

/** Rejects anything that is not a plain object (guards accidental misuse). */
function assertObject(obj: unknown, what: string): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`${what} must be a plain object.`);
  }
  return obj as Record<string, unknown>;
}

/**
 * Builds the `WHERE` fragment for a conditions object.
 *
 * Three value shapes are recognised (see `WhereValue`): a plain value becomes
 * `c = ?`, `null` becomes `c IS NULL`, and an array becomes `c IN (?, …)` with
 * one bind per element. An empty array collapses to `1 = 0` — the semantically
 * correct "matches nothing" — rather than emitting `IN ()`, which SQLite
 * rejects as a syntax error.
 *
 * Empty conditions collapse to no WHERE clause at all — callers that need
 * "must match something" semantics should not pass an empty object.
 */
function buildWhere<T>(
  model: Model<T>,
  where: Record<string, unknown>,
): { sql: string; binds: unknown[] } {
  const columns = Object.keys(where);
  if (columns.length === 0) return { sql: "", binds: [] };

  const fragments: string[] = [];
  const binds: unknown[] = [];

  for (const column of columns) {
    assertColumn(model, column);
    const value = where[column];

    if (value === null) {
      fragments.push(`${column} IS NULL`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        fragments.push("1 = 0");
      } else {
        fragments.push(`(${column} IN (${value.map(() => "?").join(", ")}))`);
        binds.push(...value);
      }
    } else {
      fragments.push(`${column} = ?`);
      binds.push(value);
    }
  }

  return { sql: ` WHERE ${fragments.join(" AND ")}`, binds };
}

/** Builds an `ORDER BY c1, c2` fragment, ascending or descending as a whole. */
function buildOrder<T>(
  model: Model<T>,
  orderBy?: readonly (keyof T & string)[],
  dir: "asc" | "desc" = "asc",
): string {
  if (!orderBy?.length) return "";
  orderBy.forEach((c) => assertColumn(model, c));
  return ` ORDER BY ${orderBy.join(", ")} ${dir.toUpperCase()}`;
}

/** Coerces limit/offset to plain integers before they are inlined into the SQL. */
function asInt(value: number | undefined, what: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer, got ${value}.`);
  }
  return value;
}

// =============================================================================
// Repository
// =============================================================================

export interface AllOptions<T> {
  /** Columns to order by, in order. */
  orderBy?: readonly (keyof T & string)[];
  /** Direction applied to every `orderBy` column as a whole. Default `asc`. */
  orderDir?: "asc" | "desc";
  /** Maximum rows to return. Must be a non-negative integer; inlined, not bound. */
  limit?: number;
  /** Rows to skip (requires `limit` to be useful). Inlined, not bound. */
  offset?: number;
}

/**
 * A typed repository over one table. Created via `repo()`; one per call site is
 * fine — the object holds no state, and building it costs only the closure.
 */
export interface Repo<T> {
  /** Fetches one row by primary key. */
  get(keyValue: unknown): Promise<T | null>;

  /** Fetches one row matching all conditions (first match, unspecified order). */
  getWhere(where: Where<T>): Promise<T | null>;

  /** Fetches every row matching the conditions, with optional order/limit. */
  all(where?: Where<T>, opts?: AllOptions<T>): Promise<T[]>;

  /** Counts rows matching the conditions. */
  count(where?: Where<T>): Promise<number>;

  /** True if at least one row matches the conditions. */
  exists(where: Where<T>): Promise<boolean>;

  /**
   * Inserts one row. Columns must all be declared; values are bound.
   * Returns `meta` (D1's `last_row_id` / `changes`), not the inserted row —
   * callers already know the values they passed; use `insertReturning` when
   * an autoincrement id is needed.
   */
  insert(row: Partial<T>): Promise<D1Result>;

  /**
   * Inserts one row and returns the requested columns of what was written —
   * the way to get an autoincrement id out of an INSERT. D1 (like SQLite)
   * supports `RETURNING`; default is the primary key column.
   */
  insertReturning<R>(
    row: Partial<T>,
    returning?: readonly (keyof T & string)[],
  ): Promise<R | null>;

  /**
   * Inserts one row, ignoring a uniqueness conflict. Returns rows changed:
   * `1` means inserted, `0` means a row with the same unique key (the primary
   * key, or any other UNIQUE index) already existed — which is how the admin
   * wizard distinguishes "promoted" from "already an admin".
   */
  insertOrIgnore(row: Partial<T>): Promise<number>;

  /** Inserts many rows in one statement (one prepared statement, N binds). */
  insertMany(rows: Partial<T>[]): Promise<D1Result>;

  /**
   * Insert-or-update on the primary key. `update` names the columns to overwrite
   * when the row already exists; omitted, it defaults to every non-key column of
   * `row`. Used by `ensureUser`-style idempotent writes.
   */
  upsert(row: Partial<T>, update?: readonly (keyof T & string)[]): Promise<D1Result>;

  /**
   * Conditional update: sets `set` on every row matching `where`.
   *
   * Returns the number of rows changed, which is what makes one-time claims
   * atomic without a transaction: `updateWhere({ id, test_used: 0 }, { test_used: 1 })`
   * returns 1 for the caller that won the race and 0 for everyone else.
   */
  updateWhere(where: Where<T>, set: Partial<T>): Promise<number>;

  /** Updates one row addressed by primary key. Returns rows changed (0 or 1). */
  update(keyValue: unknown, set: Partial<T>): Promise<number>;

  /** Deletes every row matching the conditions. Returns rows deleted. */
  deleteWhere(where: Where<T>): Promise<number>;

  /**
   * Escape hatch returning a *single* row for anything the typed helpers do not
   * cover — aggregates, expressions, `RETURNING` from hand-written SQL. Values
   * are bound parameters; the SQL string must be a literal in the caller's
   * code, exactly like the hand-written queries this layer replaces.
   */
  raw<R>(sql: string, ...binds: unknown[]): Promise<R>;

  /** The multi-row form of `raw()` — same rules, returns every matching row. */
  rawAll<R>(sql: string, ...binds: unknown[]): Promise<R[]>;
}

/** Builds the repository for one model against one D1 binding. */
export function repo<T>(db: D1Database, model: Model<T>): Repo<T> {
  const { table, key } = model;

  return {
    async get(keyValue: unknown): Promise<T | null> {
      return db
        .prepare(`SELECT * FROM ${table} WHERE ${key} = ?`)
        .bind(keyValue)
        .first<T>();
    },

    async getWhere(where: Where<T>): Promise<T | null> {
      const w = buildWhere(model, assertObject(where, "where"));
      const stmt = db.prepare(`SELECT * FROM ${table}${w.sql}`);
      return (w.binds.length ? stmt.bind(...w.binds) : stmt).first<T>();
    },

    async all(where?: Where<T>, opts?: AllOptions<T>): Promise<T[]> {
      const w = buildWhere(model, assertObject(where ?? {}, "where"));
      const order = buildOrder(model, opts?.orderBy, opts?.orderDir);
      let limitSql = "";
      if (opts?.limit !== undefined) {
        limitSql = ` LIMIT ${asInt(opts.limit, "limit")}`;
        if (opts.offset !== undefined) limitSql += ` OFFSET ${asInt(opts.offset, "offset")}`;
      }

      const stmt = db.prepare(`SELECT * FROM ${table}${w.sql}${order}${limitSql}`);
      const result = await (w.binds.length ? stmt.bind(...w.binds) : stmt).all<T>();
      return result.results ?? [];
    },

    async count(where?: Where<T>): Promise<number> {
      const w = buildWhere(model, assertObject(where ?? {}, "where"));
      const stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${w.sql}`);
      const result = await (w.binds.length ? stmt.bind(...w.binds) : stmt).first<{ n: number }>();
      return result?.n ?? 0;
    },

    async exists(where: Partial<T>): Promise<boolean> {
      return (await this.count(where)) > 0;
    },

    async insert(row: Partial<T>): Promise<D1Result> {
      const r = assertObject(row, "row");
      const columns = Object.keys(r);
      if (columns.length === 0) throw new Error("insert() needs at least one column.");
      columns.forEach((c) => assertColumn(model, c));

      return db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) ` +
            `VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .bind(...columns.map((c) => r[c]))
        .run();
    },

    async insertReturning<R>(
      row: Partial<T>,
      returning: readonly (keyof T & string)[] = [key],
    ): Promise<R | null> {
      const r = assertObject(row, "row");
      const columns = Object.keys(r);
      if (columns.length === 0) throw new Error("insertReturning() needs at least one column.");
      columns.forEach((c) => assertColumn(model, c));
      returning.forEach((c) => assertColumn(model, c));

      return db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) ` +
            `VALUES (${columns.map(() => "?").join(", ")}) ` +
            `RETURNING ${returning.join(", ")}`,
        )
        .bind(...columns.map((c) => r[c]))
        .first<R>();
    },

    async insertOrIgnore(row: Partial<T>): Promise<number> {
      const r = assertObject(row, "row");
      const columns = Object.keys(r);
      if (columns.length === 0) throw new Error("insertOrIgnore() needs at least one column.");
      columns.forEach((c) => assertColumn(model, c));

      // No conflict target: DO NOTHING applies to any UNIQUE constraint the
      // table declares, which is what "already exists" means here.
      const result = await db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) ` +
            `VALUES (${columns.map(() => "?").join(", ")}) ` +
            `ON CONFLICT DO NOTHING`,
        )
        .bind(...columns.map((c) => r[c]))
        .run();

      return result.meta?.changes ?? 0;
    },

    async insertMany(rows: Partial<T>[]): Promise<D1Result> {
      if (rows.length === 0) throw new Error("insertMany() needs at least one row.");
      const first = assertObject(rows[0], "row");
      const columns = Object.keys(first);
      columns.forEach((c) => assertColumn(model, c));

      const binds: unknown[] = [];
      for (const row of rows) {
        const r = assertObject(row, "row");
        for (const c of columns) binds.push(r[c]);
      }

      const placeholders = rows
        .map(() => `(${columns.map(() => "?").join(", ")})`)
        .join(", ");

      return db
        .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`)
        .bind(...binds)
        .run();
    },

    async upsert(row: Partial<T>, update?: readonly (keyof T & string)[]): Promise<D1Result> {
      const r = assertObject(row, "row");
      const columns = Object.keys(r);
      if (columns.length === 0) throw new Error("upsert() needs at least one column.");
      columns.forEach((c) => assertColumn(model, c));

      const updateColumns = update ?? columns.filter((c) => c !== key);
      updateColumns.forEach((c) => assertColumn(model, c));

      return db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) ` +
            `VALUES (${columns.map(() => "?").join(", ")}) ` +
            `ON CONFLICT(${key}) DO UPDATE SET ` +
            updateColumns.map((c) => `${c} = excluded.${c}`).join(", "),
        )
        .bind(...columns.map((c) => r[c]))
        .run();
    },

    async updateWhere(where: Where<T>, set: Partial<T>): Promise<number> {
      const s = assertObject(set, "set");
      const setColumns = Object.keys(s);
      if (setColumns.length === 0) throw new Error("updateWhere() needs at least one column to set.");
      setColumns.forEach((c) => assertColumn(model, c));

      const w = buildWhere(model, assertObject(where, "where"));

      // `touch` is appended as SQL rather than bound: it is SQLite's own clock,
      // the same one `DEFAULT CURRENT_TIMESTAMP` writes on insert. Skipped when
      // the caller sets the column explicitly — the explicit value wins.
      const touchSql =
        model.touch !== undefined && s[model.touch] === undefined
          ? `, ${model.touch} = CURRENT_TIMESTAMP`
          : "";

      const result = await db
        .prepare(
          `UPDATE ${table} SET ${setColumns.map((c) => `${c} = ?`).join(", ")}${touchSql}${w.sql}`,
        )
        .bind(...setColumns.map((c) => s[c]), ...w.binds)
        .run();

      return result.meta?.changes ?? 0;
    },

    async update(keyValue: unknown, set: Partial<T>): Promise<number> {
      return this.updateWhere({ [key]: keyValue } as Partial<T>, set);
    },

    async deleteWhere(where: Where<T>): Promise<number> {
      const w = buildWhere(model, assertObject(where, "where"));
      if (w.sql === "") throw new Error("deleteWhere() refuses to run without conditions.");

      const result = await db
        .prepare(`DELETE FROM ${table}${w.sql}`)
        .bind(...w.binds)
        .run();

      return result.meta?.changes ?? 0;
    },

    raw<R>(sql: string, ...binds: unknown[]): Promise<R> {
      return db.prepare(sql).bind(...binds).first<R>() as Promise<R>;
    },

    async rawAll<R>(sql: string, ...binds: unknown[]): Promise<R[]> {
      const result = await db.prepare(sql).bind(...binds).all<R>();
      return result.results ?? [];
    },
  };
}
