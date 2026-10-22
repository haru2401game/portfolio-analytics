import assert from "node:assert/strict";
import worker, { buildReport, jstDay, addDays } from "../src/index.js";
import { createD1 } from "./d1.mjs";

const root = new URL("..", import.meta.url).pathname;
const db = createD1(root + "migrations/0001_init.sql");
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };

const env = {
    DB: db,
    ALLOWED_ORIGINS: "https://haru2401game.github.io",
    DASHBOARD_PASSWORD: "correct horse",
    SESSION_SECRET: "s3cret",
    DISCORD_WEBHOOK_URL: "https://discord.test/hook",
    DASHBOARD_URL: "https://pa.example/",
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`) },
};
const ctx = { waitUntil: (p) => p };
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/130";
const call = (path, init = {}) => worker.fetch(new Request(`https://pa.example${path}`, init), env, ctx);
const post = (body, headers = {}) => call("/collect", {
    method: "POST",
    headers: { Origin: "https://haru2401game.github.io", "User-Agent": UA, "Content-Type": "text/plain", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
});
const count = (where = "1=1") => db.raw.prepare(`SELECT COUNT(*) n FROM events WHERE ${where}`).get().n;

// --- collect
let r = await post({ s: "abc12345", w: 1440, events: [{ t: "pageview", n: "/", r: "https://www.google.com/search?q=x" }] });
assert.equal(r.status, 204);
assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://haru2401game.github.io");
assert.equal(count(), 1);
assert.equal(db.raw.prepare("SELECT referrer, device FROM events").get().referrer, "google.com");

await post({ s: "abc12345", w: 1440, events: [{ t: "section_view", n: "about" }, { t: "section_view", n: "about" }] });
await post({ s: "abc12345", w: 1440, events: [{ t: "section_view", n: "about" }] });
assert.equal(count("type='section_view'"), 1, "section counted once per session");

await post({ s: "abc12345", events: [{ t: "evil", n: "x" }, { t: "work_click", n: "A".repeat(200) }] });
assert.equal(count("type='evil'"), 0);
assert.equal(db.raw.prepare("SELECT length(name) l FROM events WHERE type='work_click'").get().l, 80);

await post({ s: "abc12345", events: [{ t: "pageview" }] }, { Origin: "https://evil.example" });
await post({ s: "abc12345", events: [{ t: "pageview" }] }, { "User-Agent": "Googlebot/2.1" });
await post({ s: "BAD SESSION", events: [{ t: "pageview" }] });
r = await post("not json");
assert.equal(r.status, 400);
assert.equal(count("type='pageview'"), 1, "foreign origin / bot / bad session ignored");

// mobile device detection
await post({ s: "mob12345", w: 390, events: [{ t: "pageview", r: "" }] }, { "User-Agent": "Mozilla/5.0 (iPhone) Mobile Safari" });
assert.equal(db.raw.prepare("SELECT device FROM events WHERE session='mob12345'").get().device, "mobile");

// session cap
const many = Array.from({ length: 20 }, () => ({ t: "ui_open", n: "x" }));
for (let i = 0; i < 20; i += 1) await post({ s: "spam1234", events: many });
assert.equal(count("session='spam1234'"), 300, "per-session cap");
db.raw.exec("DELETE FROM events WHERE session='spam1234'");

// --- auth
r = await call("/");
assert.equal(r.status, 302);
assert.match(r.headers.get("Location"), /\/login$/);
r = await call("/api/summary");
assert.equal(r.status, 401);
r = await call("/login");
assert.equal(await r.text(), "asset:/login.html");
assert.equal(r.headers.get("Cache-Control"), "no-store");

const form = (pw) => { const f = new FormData(); f.set("password", pw); return f; };
r = await call("/login", { method: "POST", body: form("wrong") });
assert.match(r.headers.get("Location"), /error=1/);
r = await call("/login", { method: "POST", body: form("correct horse") });
assert.equal(r.status, 303);
const cookie = r.headers.get("Set-Cookie");
assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
const auth = { headers: { Cookie: cookie.split(";")[0] } };
r = await call("/", auth);
assert.equal(await r.text(), "asset:/index.html");
r = await call("/app.js", auth);
assert.equal(await r.text(), "asset:/app.js");

// forged cookie
r = await call("/", { headers: { Cookie: `pa_login=${Date.now() + 1e9}.deadbeef` } });
assert.equal(r.status, 302);
// expired cookie with otherwise valid shape
r = await call("/api/summary", { headers: { Cookie: `pa_login=1.${"0".repeat(64)}` } });
assert.equal(r.status, 401);

// lockout after 10 failures
for (let i = 0; i < 10; i += 1) await call("/login", { method: "POST", body: form("nope") });
r = await call("/login", { method: "POST", body: form("correct horse") });
assert.match(r.headers.get("Location"), /error=locked/);
db.raw.exec("DELETE FROM login_failures");

// --- summary
r = await call("/api/summary?days=7", auth);
const s = await r.json();
assert.equal(s.series.length, 7);
assert.equal(s.totals.pv, 2);
assert.equal(s.totals.sessions, 2);
assert.equal(s.sections.find((x) => x.id === "about").sessions, 1);
assert.equal(s.sections.find((x) => x.id === "about").rate, 0.5);
assert.equal(s.works[0].count, 1);
assert.deepEqual(s.referrers.map((x) => x.name).sort(), ["google.com", "直接・不明"]);

// --- report: insert yesterday data
const today = jstDay(Date.now());
const y = addDays(today, -1);
const ins = db.raw.prepare("INSERT INTO events (ts, day, type, name, session, referrer, device, country) VALUES (0,?,?,?,?,?,?,?)");
ins.run(y, "pageview", "/", "y1aaaaaa", "", "desktop", "JP");
ins.run(y, "pageview", "/", "y2aaaaaa", "note.com", "mobile", "JP");
ins.run(y, "section_view", "about", "y1aaaaaa", "", "desktop", "JP");
ins.run(y, "work_click", "Falien", "y1aaaaaa", "", "desktop", "JP");
const report = await buildReport(db, y, env.DASHBOARD_URL);
const text = report.embeds[0].description;
assert.match(report.embeds[0].title, new RegExp(y));
assert.match(text, /閲覧数 \*\*2\*\*/);
assert.match(text, /About 50%/);
assert.match(text, /1\. Falien　1回/);
assert.match(text, /スマホ 1/);

// empty day report
const empty = await buildReport(db, addDays(today, -20), "");
assert.match(empty.embeds[0].description, /アクセスはありませんでした/);

// scheduled: sends yesterday report
const scheduledAt = Date.parse(`${today}T20:00:00Z`) - 9 * 3600 * 1000 + 20 * 3600 * 1000; // any time today JST
let pending;
await worker.scheduled({ scheduledTime: Date.parse(`${addDays(today, 0)}T00:00:00+09:00`) + 5 * 3600 * 1000 }, env, { waitUntil: (p) => { pending = p; } });
await pending;
assert.equal(sent.length, 1);
assert.match(sent[0].body.embeds[0].title, new RegExp(y));

// report API: same-origin only
r = await call("/api/report", { method: "POST", headers: { ...auth.headers, Origin: "https://evil.example" }, body: "{}" });
assert.equal(r.status, 403);
r = await call("/api/report", { method: "POST", headers: { ...auth.headers, Origin: "https://pa.example" }, body: "{}" });
assert.deepEqual((await r.json()).sent, true);

console.log("all unit tests passed");
console.log("\n--- sample Discord report ---\n" + report.embeds[0].title + "\n" + text);
