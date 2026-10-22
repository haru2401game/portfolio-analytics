/**
 * portfolio-analytics
 *
 * ポートフォリオサイトのアクセス解析を Cloudflare Workers + D1 だけで行う。
 *
 *   POST /collect        ポートフォリオから届く記録を受け取る（誰でも送れる・保存のみ）
 *   GET  /               ダッシュボード（ログインした本人だけ）
 *   POST /login          パスワードでログイン
 *   POST /logout         ログアウト
 *   GET  /api/summary    ダッシュボード用の集計（ログイン必須）
 *   POST /api/report     Discordへ日報をテスト送信（ログイン必須）
 *   cron（毎朝5:00 JST）  前日分の日報を Discord に送る
 */

/* ========================================
   設定
======================================== */

// セクションの一覧はポートフォリオ側から自動で届く（sections テーブル）。
// ここは、まだ届いていないときに使う予備の表示名と並び順
export const SECTIONS = [
    ["hero", "トップ"],
    ["about", "About"],
    ["achievements", "Achievements"],
    ["featured-works", "Featured Works"],
    ["other-works", "Other Works"],
    ["play-games", "Play Games"],
    ["what-i-can-do", "Skills"],
    ["timeline", "Timeline"],
    ["blog", "Blog"],
    ["contact", "Contact"],
];

// 受け付ける記録の種類
const EVENT_TYPES = new Set([
    "pageview",       // ページを開いた
    "section_view",   // セクションが画面の中央まで来た（読まれた）
    "work_click",     // 作品カードのリンク
    "play_click",     // Play Games のリンク（unityroom など）
    "photo_open",     // 写真の拡大
    "video_play",     // 動画の再生
    "ui_open",        // 「その他作品」「これまでのクエスト」を開いた
    "outbound_click", // 外部サイトへのリンク（note・SNSなど）
    "contact_click",  // メールなどの連絡リンク
]);

const CLICK_TYPES = ["work_click", "play_click", "photo_open", "video_play", "ui_open", "outbound_click", "contact_click"];

const MAX_EVENTS_PER_SESSION = 300;   // 1回の訪問で受け付ける記録の上限（荒らし対策）
const RETENTION_DAYS = 400;           // 記録を残す日数
const SECTION_ACTIVE_DAYS = 30;       // この日数のあいだ届いていないセクションは「削除された」とみなして一覧から外す
const MAX_SECTIONS = 60;              // 登録できるセクション数の上限（荒らし対策）
const LOGIN_DAYS = 30;                // ログインの有効期限
const LOGIN_FAIL_LIMIT = 10;          // 15分間にこの回数ログインに失敗したら一時停止
const BOT_PATTERN = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor|curl|wget|python|axios|node-fetch/i;

const JST_OFFSET = 9 * 60 * 60 * 1000;

/* ========================================
   日付ユーティリティ（日本時間）
======================================== */

export function jstDay(ms) {
    return new Date(ms + JST_OFFSET).toISOString().slice(0, 10);
}

export function addDays(day, delta) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
}

function isDay(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/* ========================================
   エントリーポイント
======================================== */

export default {
    async fetch(request, env, ctx) {
        try {
            return await route(request, env, ctx);
        } catch (error) {
            console.error(error);
            return json({ error: "server_error" }, 500);
        }
    },

    async scheduled(event, env, ctx) {
        const yesterday = addDays(jstDay(event.scheduledTime ?? Date.now()), -1);
        ctx.waitUntil((async () => {
            await sendDailyReport(env, yesterday);
            await cleanup(env);
        })());
    },
};

async function route(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/collect") return collect(request, env);
    if (path === "/login" && request.method === "POST") return login(request, env);
    if (path === "/logout" && request.method === "POST") return logout();

    // ログイン画面とその見た目に必要なファイルだけはログイン前でも返す
    if (path === "/login" || path === "/login.html") return asset(env, request, "/login.html");
    if (path === "/style.css" || path === "/favicon.svg") return asset(env, request, path);

    const authed = await isAuthed(request, env);

    if (path.startsWith("/api/")) {
        if (!authed) return json({ error: "unauthorized" }, 401);
        if (path === "/api/summary" && request.method === "GET") return apiSummary(url, env);
        if (path === "/api/report" && request.method === "POST") return apiReport(request, env);
        return json({ error: "not_found" }, 404);
    }

    if (!authed) return Response.redirect(new URL("/login", url).toString(), 302);
    if (path === "/" || path === "/index.html") return asset(env, request, "/index.html");
    if (path === "/app.js") return asset(env, request, path);

    return new Response("Not Found", { status: 404 });
}

async function asset(env, request, path) {
    const response = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
    });
}

/* ========================================
   記録の受け取り
======================================== */

function allowedOrigins(env) {
    return String(env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function cleanText(value, max) {
    return String(value ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

// Discord やダッシュボードで悪さをしない文字だけ残す（@メンション・リンク記法などを除く）
function cleanLabel(value) {
    return cleanText(value, 40).replace(/[@`*_~|<>[\]()#]/g, "").trim();
}

function deviceFrom(width, ua) {
    const w = Number(width) || 0;
    if (/iPad|Tablet/i.test(ua) || (w >= 600 && w < 1024 && /Mobile|Android/i.test(ua))) return "tablet";
    if (/Mobi|Android|iPhone/i.test(ua) || (w > 0 && w < 600)) return "mobile";
    return "desktop";
}

function referrerHost(value) {
    try {
        const host = new URL(String(value)).hostname.toLowerCase();
        return host.replace(/^www\./, "").slice(0, 100);
    } catch {
        return "";
    }
}

async function collect(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env);
    const cors = allowed.includes(origin)
        ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" }
        : {};

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return new Response(null, { status: 405 });

    // 許可したサイト（ポートフォリオ）以外からの記録は保存しない
    if (!allowed.includes(origin)) return new Response(null, { status: 204 });

    const ua = request.headers.get("User-Agent") || "";
    if (!ua || BOT_PATTERN.test(ua)) return new Response(null, { status: 204, headers: cors });

    let body;
    try {
        const text = await request.text();
        if (text.length > 4000) return new Response(null, { status: 413, headers: cors });
        body = JSON.parse(text);
    } catch {
        return new Response(null, { status: 400, headers: cors });
    }

    const list = Array.isArray(body.events) ? body.events.slice(0, 20) : [body];
    const session = cleanText(body.s ?? list[0]?.s, 32);
    if (!/^[a-z0-9]{8,32}$/.test(session)) return new Response(null, { status: 400, headers: cors });

    const now = Date.now();
    const day = jstDay(now);
    const device = deviceFrom(body.w ?? list[0]?.w, ua);
    const country = cleanText(request.cf?.country, 2);

    const used = await env.DB
        .prepare("SELECT COUNT(*) AS n FROM events WHERE session = ?")
        .bind(session)
        .first();
    let room = MAX_EVENTS_PER_SESSION - Number(used?.n || 0);

    const statements = [];
    for (const item of list) {
        if (room <= 0) break;
        const type = cleanText(item.t, 20);
        if (!EVENT_TYPES.has(type)) continue;
        const name = cleanText(item.n, 80);
        const referrer = type === "pageview" ? referrerHost(item.r) : "";

        if (type === "section_view") {
            if (!/^[a-z0-9_-]{1,40}$/.test(name)) continue;

            // セクション一覧（表示名・順番）を最新に保つ
            const label = cleanLabel(item.l) || name;
            const ord = Math.min(Math.max(Math.floor(Number(item.o)) || 0, 0), 999);
            statements.push(env.DB.prepare(
                `INSERT INTO sections (id, label, ord, updated)
                 SELECT ?, ?, ?, ?
                 WHERE (SELECT COUNT(*) FROM sections) < ? OR EXISTS (SELECT 1 FROM sections WHERE id = ?)
                 ON CONFLICT(id) DO UPDATE SET label = excluded.label, ord = excluded.ord, updated = excluded.updated`
            ).bind(name, label, ord, now, MAX_SECTIONS, name));

            // 同じ訪問で同じセクションは1回だけ数える
            statements.push(env.DB.prepare(
                `INSERT INTO events (ts, day, type, name, session, referrer, device, country)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM events WHERE session = ? AND type = 'section_view' AND name = ?)`
            ).bind(now, day, type, name, session, referrer, device, country, session, name));
        } else {
            statements.push(env.DB.prepare(
                "INSERT INTO events (ts, day, type, name, session, referrer, device, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(now, day, type, name, session, referrer, device, country));
        }
        room -= 1;
    }

    if (statements.length) await env.DB.batch(statements);
    return new Response(null, { status: 204, headers: cors });
}

/* ========================================
   ログイン（本人だけがダッシュボードを見られるように）
======================================== */

const encoder = new TextEncoder();

async function hmac(secret, message) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function readCookie(request, name) {
    const cookie = request.headers.get("Cookie") || "";
    for (const part of cookie.split(";")) {
        const [key, ...rest] = part.trim().split("=");
        if (key === name) return rest.join("=");
    }
    return "";
}

async function isAuthed(request, env) {
    if (!env.SESSION_SECRET) return false;
    const value = readCookie(request, "pa_login");
    const [exp, signature] = value.split(".");
    if (!exp || !signature || Number(exp) < Date.now()) return false;
    return sameText(signature, await hmac(env.SESSION_SECRET, `login:${exp}`));
}

async function login(request, env) {
    if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) {
        return Response.redirect(new URL("/login?error=setup", request.url).toString(), 303);
    }

    const since = Date.now() - 15 * 60 * 1000;
    const fails = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ts > ?").bind(since).first();
    if (Number(fails?.n || 0) >= LOGIN_FAIL_LIMIT) {
        return Response.redirect(new URL("/login?error=locked", request.url).toString(), 303);
    }

    const form = await request.formData();
    const password = String(form.get("password") || "");

    // 長さの違いから推測されないよう、両方をハッシュにしてから比べる
    const ok = sameText(
        await hmac(env.SESSION_SECRET, `pw:${password}`),
        await hmac(env.SESSION_SECRET, `pw:${env.DASHBOARD_PASSWORD}`)
    );

    if (!ok) {
        await env.DB.prepare("INSERT INTO login_failures (ts) VALUES (?)").bind(Date.now()).run();
        return Response.redirect(new URL("/login?error=1", request.url).toString(), 303);
    }

    await env.DB.prepare("DELETE FROM login_failures").run();
    const exp = Date.now() + LOGIN_DAYS * 24 * 60 * 60 * 1000;
    const value = `${exp}.${await hmac(env.SESSION_SECRET, `login:${exp}`)}`;
    return new Response(null, {
        status: 303,
        headers: {
            Location: "/",
            "Set-Cookie": `pa_login=${value}; Path=/; Max-Age=${LOGIN_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`,
        },
    });
}

function logout() {
    return new Response(null, {
        status: 303,
        headers: { Location: "/login", "Set-Cookie": "pa_login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" },
    });
}

/* ========================================
   集計
======================================== */

const FALLBACK_SECTIONS = new Map(SECTIONS.map(([id, label], index) => [id, { label, ord: index }]));

function rows(result) {
    return result?.results ?? [];
}

export async function buildSummary(db, to, days) {
    const from = addDays(to, -(days - 1));
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(days - 1));

    const range = (sql) => db.prepare(sql).bind(from, to);

    const activeSince = Date.now() - SECTION_ACTIVE_DAYS * 24 * 60 * 60 * 1000;

    const [daily, unique, prev, sections, sectionMeta, clicks, referrers, devices, countries] = await db.batch([
        range(`SELECT day,
                      SUM(type = 'pageview') AS pv,
                      COUNT(DISTINCT CASE WHEN type = 'pageview' THEN session END) AS sessions
               FROM events WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`),
        range(`SELECT COUNT(DISTINCT session) AS n FROM events WHERE type = 'pageview' AND day BETWEEN ? AND ?`),
        db.prepare(`SELECT SUM(type = 'pageview') AS pv,
                           COUNT(DISTINCT CASE WHEN type = 'pageview' THEN session END) AS sessions
                    FROM events WHERE day BETWEEN ? AND ?`).bind(prevFrom, prevTo),
        range(`SELECT name, COUNT(DISTINCT session) AS sessions
               FROM events WHERE type = 'section_view' AND day BETWEEN ? AND ? GROUP BY name`),
        db.prepare("SELECT id, label, ord, updated FROM sections ORDER BY ord, id"),
        range(`SELECT type, name, COUNT(*) AS count, COUNT(DISTINCT session) AS sessions
               FROM events WHERE type IN (${CLICK_TYPES.map((t) => `'${t}'`).join(",")}) AND day BETWEEN ? AND ?
               GROUP BY type, name ORDER BY count DESC, name`),
        range(`SELECT referrer, COUNT(DISTINCT session) AS sessions
               FROM events WHERE type = 'pageview' AND day BETWEEN ? AND ?
               GROUP BY referrer ORDER BY sessions DESC LIMIT 10`),
        range(`SELECT device, COUNT(DISTINCT session) AS sessions
               FROM events WHERE type = 'pageview' AND day BETWEEN ? AND ?
               GROUP BY device ORDER BY sessions DESC`),
        range(`SELECT country, COUNT(DISTINCT session) AS sessions
               FROM events WHERE type = 'pageview' AND day BETWEEN ? AND ?
               GROUP BY country ORDER BY sessions DESC LIMIT 8`),
    ]);

    // 日付の抜けを0で埋める
    const byDay = new Map(rows(daily).map((row) => [row.day, row]));
    const series = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
        const row = byDay.get(day);
        series.push({ day, pv: Number(row?.pv || 0), sessions: Number(row?.sessions || 0) });
    }

    const pv = series.reduce((sum, row) => sum + row.pv, 0);
    const sessionTotal = Number(rows(unique)[0]?.n || 0);

    // セクション一覧：ポートフォリオから届いた一覧（最近届いたもの）＋この期間に記録があるもの
    const sectionMap = new Map(rows(sections).map((row) => [row.name, Number(row.sessions)]));
    const meta = new Map();
    for (const row of rows(sectionMeta)) {
        if (Number(row.updated) >= activeSince || sectionMap.has(row.id)) {
            meta.set(row.id, { label: row.label, ord: Number(row.ord) });
        }
    }
    if (!meta.size) {
        FALLBACK_SECTIONS.forEach((value, id) => meta.set(id, value));
    }
    for (const id of sectionMap.keys()) {
        if (!meta.has(id)) meta.set(id, FALLBACK_SECTIONS.get(id) || { label: id, ord: 999 });
    }
    const sectionList = [...meta.entries()]
        .sort((a, b) => a[1].ord - b[1].ord || a[0].localeCompare(b[0]))
        .map(([id, { label }]) => {
            const reached = sectionMap.get(id) || 0;
            return { id, label, sessions: reached, rate: sessionTotal ? reached / sessionTotal : 0 };
        });

    const group = (type) => rows(clicks)
        .filter((row) => row.type === type)
        .map((row) => ({ name: row.name || "(名前なし)", count: Number(row.count), sessions: Number(row.sessions) }));

    const prevRow = rows(prev)[0] || {};

    return {
        range: { from, to, days },
        totals: {
            pv,
            sessions: sessionTotal,
            prevPv: Number(prevRow.pv || 0),
            prevSessions: Number(prevRow.sessions || 0),
            workClicks: group("work_click").reduce((sum, row) => sum + row.count, 0),
            avgSections: sessionTotal
                ? sectionList.reduce((sum, row) => sum + row.sessions, 0) / sessionTotal
                : 0,
        },
        series,
        sections: sectionList,
        works: group("work_click"),
        plays: group("play_click"),
        photos: group("photo_open"),
        videos: group("video_play"),
        ui: group("ui_open"),
        outbound: group("outbound_click"),
        contact: group("contact_click"),
        referrers: rows(referrers).map((row) => ({ name: row.referrer || "直接・不明", sessions: Number(row.sessions) })),
        devices: rows(devices).map((row) => ({ name: row.device || "不明", sessions: Number(row.sessions) })),
        countries: rows(countries).map((row) => ({ name: row.country || "不明", sessions: Number(row.sessions) })),
    };
}

async function apiSummary(url, env) {
    const yesterday = addDays(jstDay(Date.now()), -1);
    const today = jstDay(Date.now());
    const to = isDay(url.searchParams.get("to")) ? url.searchParams.get("to") : today;
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
    const summary = await buildSummary(env.DB, to, days);
    return json({ ...summary, today, yesterday });
}

/* ========================================
   Discord 日報
======================================== */

function signed(n) {
    return n > 0 ? `+${n}` : n < 0 ? `${n}` : "±0";
}

function percent(rate) {
    return `${Math.round(rate * 100)}%`;
}

export async function buildReport(db, day, dashboardUrl) {
    const s = await buildSummary(db, day, 1);
    const week = await buildSummary(db, addDays(day, -1), 7);
    const avg = week.totals.pv / 7;
    const t = s.totals;
    const lines = [];

    lines.push(`👀 閲覧数 **${t.pv}**　前日比 ${signed(t.pv - t.prevPv)}　/ 前の7日平均 ${avg.toFixed(1)}`);
    lines.push(`🧑 訪問 **${t.sessions}**　前日比 ${signed(t.sessions - t.prevSessions)}`);

    if (t.sessions === 0) {
        lines.push("\nこの日のアクセスはありませんでした。");
    } else {
        lines.push(`\n**📖 読まれたセクション**（訪問のうち何%が到達したか）`);
        const bar = (rate) => "■".repeat(Math.round(rate * 10)).padEnd(10, "□");
        for (const row of s.sections) {
            lines.push(`\`${bar(row.rate)}\` ${row.label} ${percent(row.rate)}`);
        }

        lines.push(`\n**🎮 クリックされた作品**`);
        if (s.works.length) {
            s.works.slice(0, 5).forEach((row, i) => lines.push(`${i + 1}. ${row.name}　${row.count}回`));
        } else {
            lines.push("なし");
        }

        const extra = [
            ["🕹️ Play Games", s.plays],
            ["🖼️ 写真の拡大", s.photos],
            ["✉️ 連絡", s.contact],
        ].filter(([, list]) => list.length);
        for (const [label, list] of extra) {
            lines.push(`${label}：${list.slice(0, 3).map((row) => `${row.name}（${row.count}）`).join("、")}`);
        }

        lines.push(`\n**🔗 流入元**：${s.referrers.slice(0, 3).map((row) => `${row.name}（${row.sessions}）`).join("、")}`);
        lines.push(`**📱 端末**：${s.devices.map((row) => `${deviceLabel(row.name)} ${row.sessions}`).join(" / ")}`);
    }

    return {
        username: "ポートフォリオ分析bot",
        allowed_mentions: { parse: [] },
        embeds: [{
            title: `📊 ポートフォリオ日報 ${day}`,
            url: dashboardUrl || undefined,
            description: lines.join("\n").slice(0, 4000),
            color: 0xd6363d,
        }],
    };
}

function deviceLabel(name) {
    return { mobile: "スマホ", tablet: "タブレット", desktop: "PC" }[name] || name;
}

export async function sendDailyReport(env, day) {
    if (!env.DISCORD_WEBHOOK_URL) {
        console.log("DISCORD_WEBHOOK_URL が未設定のため日報を送りません");
        return { sent: false, reason: "no_webhook" };
    }
    const payload = await buildReport(env.DB, day, env.DASHBOARD_URL);
    const response = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Discord への送信に失敗しました: ${response.status}`);
    return { sent: true };
}

async function apiReport(request, env) {
    // 他のサイトから勝手に押されないよう、同じサイトからの操作だけ受け付ける
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) return json({ error: "forbidden" }, 403);

    const body = await request.json().catch(() => ({}));
    const day = isDay(body.day) ? body.day : addDays(jstDay(Date.now()), -1);
    const result = await sendDailyReport(env, day);
    return json({ ...result, day });
}

async function cleanup(env) {
    const limit = addDays(jstDay(Date.now()), -RETENTION_DAYS);
    await env.DB.batch([
        env.DB.prepare("DELETE FROM events WHERE day < ?").bind(limit),
        env.DB.prepare("DELETE FROM login_failures WHERE ts < ?").bind(Date.now() - 24 * 60 * 60 * 1000),
    ]);
}
