// Minimal Cloudflare D1 stand-in backed by node:sqlite, for local tests only.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function createD1(schemaPath) {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(schemaPath, "utf8"));

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
