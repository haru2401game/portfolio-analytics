// Minimal Cloudflare D1 stand-in backed by node:sqlite, for local tests only.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Applies every migrations/*.sql in order (like `wrangler d1 migrations apply`).
export function createD1(migrationsDir) {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
        db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }

    class Stmt {
        constructor(sql, args = []) { this.sql = sql; this.args = args; }
        bind(...args) { return new Stmt(this.sql, args); }
        _exec() {
            const st = db.prepare(this.sql);
            if (/^\s*(SELECT|WITH)/i.test(this.sql)) {
                return { results: st.all(...this.args).map((r) => ({ ...r })), success: true };
            }
            const info = st.run(...this.args);
            return { results: [], success: true, meta: { changes: Number(info.changes) } };
        }
        async all() { return this._exec(); }
        async run() { return this._exec(); }
        async first() { return this._exec().results[0] ?? null; }
    }

    return {
        raw: db,
        prepare: (sql) => new Stmt(sql),
        batch: async (stmts) => {
            db.exec("BEGIN");
            try {
                const out = stmts.map((s) => s._exec());
                db.exec("COMMIT");
                return out;
            } catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
        },
    };
}
