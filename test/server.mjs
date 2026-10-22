// Local test server: runs the Worker's fetch() on Node with a node:sqlite D1 and a file-based ASSETS.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import worker, { addDays, jstDay } from "../src/index.js";
import { createD1 } from "./d1.mjs";

const root = new URL("..", import.meta.url).pathname;
const db = createD1(join(root, "migrations"));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const env = {
    DB: db,
    ALLOWED_ORIGINS: "https://haru2401game.github.io,http://localhost:8765",
    DASHBOARD_PASSWORD: "test-pass",
    SESSION_SECRET: "secret-for-tests",
    DASHBOARD_URL: "http://localhost:8787/",
    ASSETS: {
        async fetch(req) {
            const path = new URL(req.url).pathname;
            try {
                const body = await readFile(join(root, "public", path));
                return new Response(body, { headers: { "Content-Type": types[extname(path)] || "application/octet-stream" } });
            } catch {
                return new Response("nf", { status: 404 });
            }
        },
    },
};

// SEED=1 node test/server.mjs → http://localhost:8787 (password: test-pass) with fake data
// seed: fake visits over the last 30 days (only if SEED=1)
if (process.env.SEED) {
    const sections = ["hero", "about", "achievements", "featured-works", "other-works", "play-games", "what-i-can-do", "timeline", "blog", "contact"];
    const works = ["3D CHALLENGE #05", "Falien", "RETURN RECORD", "POTION BERSERKER", "HOOKING BOX", "Click Hero"];
    const refs = ["", "", "google.com", "note.com", "x.com", "t.co"];
    const devs = ["desktop", "desktop", "mobile", "mobile", "tablet"];
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const today = jstDay(Date.now());
    const stmts = [];
    const ins = (day, type, name, s, ref, dev) => stmts.push(db.prepare(
        "INSERT INTO events (ts, day, type, name, session, referrer, device, country) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(Date.now(), day, type, name, s, ref, dev, rnd() < 0.9 ? "JP" : "US"));
    for (let d = 30; d >= 0; d -= 1) {
        const day = addDays(today, -d);
        const visits = Math.floor(rnd() * 9) + (d < 7 ? 4 : 1);
        for (let v = 0; v < visits; v += 1) {
            const s = `s${d}x${v}${Math.floor(rnd() * 1e6)}`;
            const dev = devs[Math.floor(rnd() * devs.length)];
            ins(day, "pageview", "/", s, refs[Math.floor(rnd() * refs.length)], dev);
            const depth = Math.floor(rnd() * sections.length) + 1;
            sections.slice(0, depth).forEach((sec) => ins(day, "section_view", sec, s, "", dev));
            if (rnd() < 0.5) ins(day, "work_click", works[Math.floor(rnd() * rnd() * works.length)], s, "", dev);
            if (rnd() < 0.2) ins(day, "play_click", "unityroom", s, "", dev);
            if (rnd() < 0.2) ins(day, "photo_open", "TGS 2026", s, "", dev);
            if (rnd() < 0.1) ins(day, "contact_click", "メール", s, "", dev);
            if (rnd() < 0.15) ins(day, "outbound_click", "note.com", s, "", dev);
            if (rnd() < 0.3) ins(day, "ui_open", "Other Works", s, "", dev);
        }
    }
    await db.batch(stmts);
    console.log("seeded", stmts.length);
}

export const sentReports = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://discord.test/")) {
        sentReports.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
    }
    return realFetch(url, init);
};

const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = `http://localhost:8787${req.url}`;
    const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    // local http: drop "Secure" requirement by rewriting cookie on the way out
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = k === "set-cookie" ? v.replace("; Secure", "") : v; });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(8787, () => console.log("listening 8787"));
export { env, db };
