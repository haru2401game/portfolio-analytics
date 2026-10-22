/* Portfolio Analytics dashboard */

const $ = (id) => document.getElementById(id);
const DEVICE_LABEL = { mobile: "スマホ", tablet: "タブレット", desktop: "PC" };
const ACTION_LABEL = {
    photo_open: "写真の拡大",
    video_play: "動画の再生",
    ui_open: "一覧を開いた",
};

let currentDays = 7;
try {
    currentDays = Number(localStorage.getItem("pa-days")) || 7;
} catch { /* storage unavailable */ }

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function fmtDay(day) {
    const [, m, d] = day.split("-");
    return `${Number(m)}/${Number(d)}`;
}

function setDelta(node, now, before, days) {
    node.className = "delta";
    if (!before && !now) {
        node.textContent = "前の期間 ±0";
        return;
    }
    const diff = now - before;
    const label = days === 1 ? "前日比" : `前の${days}日比`;
    node.textContent = `${label} ${diff > 0 ? "+" : ""}${diff}`;
    if (diff > 0) node.classList.add("up");
    if (diff < 0) node.classList.add("down");
}

function renderRank(target, items, unit, emptyText = "まだ記録がありません") {
    const list = $(target);
    list.replaceChildren();
    if (!items.length) {
        list.append(el("p", "empty", emptyText));
        return;
    }
    const max = Math.max(...items.map((item) => item.value));
    items.slice(0, 10).forEach((item) => {
        const li = el("li");
        const fill = el("span", "fill");
        fill.style.width = `${max ? (item.value / max) * 100 : 0}%`;
        const label = el("span", "label", item.name);
        label.title = item.name;
        li.append(fill, label, el("span", "count", `${item.value}${unit}`));
        list.append(li);
    });
}

function renderSections(sections) {
    const list = $("sections");
    list.replaceChildren();
    sections.forEach((row) => {
        const li = el("li");
        li.append(el("span", "", row.label));
        const meter = el("span", "meter");
        meter.setAttribute("role", "img");
        meter.setAttribute("aria-label", `${row.label} ${Math.round(row.rate * 100)}%`);
        const tenths = row.rate * 10;
        for (let i = 0; i < 10; i += 1) {
            const cell = el("span");
            if (tenths >= i + 1) cell.className = "on";
            else if (tenths >= i + 0.5) cell.className = "half";
            meter.append(cell);
        }
        li.append(meter);
        const num = el("span", "num");
        num.append(el("b", "", `${Math.round(row.rate * 100)}%`), document.createTextNode(` (${row.sessions})`));
        li.append(num);
        list.append(li);
    });
}

function renderChart(series) {
    const host = $("chart");
    host.replaceChildren();
    const W = Math.max(300, host.clientWidth || 1000);
    const H = W < 600 ? 200 : 240;
    const pad = { l: 34, r: 10, t: 12, b: 26 };
    const max = Math.max(4, ...series.map((row) => Math.max(row.pv, row.sessions)));
    const step = Math.ceil(max / 4);
    const top = step * 4;
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const slot = innerW / series.length;
    const y = (v) => pad.t + innerH - (v / top) * innerH;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "chart");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "日ごとの閲覧数と訪問数のグラフ");

    const add = (tag, attrs, text) => {
        const node = document.createElementNS(ns, tag);
        Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
        if (text !== undefined) node.textContent = text;
        svg.append(node);
        return node;
    };

    for (let i = 0; i <= 4; i += 1) {
        const v = step * i;
        add("line", { class: "grid-line", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) });
        add("text", { class: "axis", x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" }, String(v));
    }

    const labelEvery = Math.ceil(series.length / Math.max(3, Math.floor(innerW / 64)));
    const tip = el("div", "tooltip");
    tip.hidden = true;

    series.forEach((row, i) => {
        const bw = Math.max(2, slot * 0.62);
        const x = pad.l + slot * i + (slot - bw) / 2;
        const bar = add("rect", { class: "bar", x, y: y(row.pv), width: bw, height: Math.max(0, y(0) - y(row.pv)), rx: Math.min(6, bw / 3) });
        const show = () => {
            bar.classList.add("is-active");
            tip.hidden = false;
            tip.textContent = `${row.day}　閲覧 ${row.pv} / 訪問 ${row.sessions}`;
            const box = host.getBoundingClientRect();
            const left = x + bw / 2;
            tip.style.left = `${Math.min(Math.max(left - 80, 0), box.width - 170)}px`;
            tip.style.top = "0px";
        };
        const hide = () => {
            bar.classList.remove("is-active");
            tip.hidden = true;
        };
        bar.addEventListener("mouseenter", show);
        bar.addEventListener("mouseleave", hide);
        bar.addEventListener("click", show);
        if (i % labelEvery === 0 || i === series.length - 1) {
            add("text", { class: "axis", x: pad.l + slot * i + slot / 2, y: H - 6, "text-anchor": "middle" }, fmtDay(row.day));
        }
    });

    if (series.length > 1) {
        const points = series.map((row, i) => `${pad.l + slot * i + slot / 2},${y(row.sessions)}`).join(" ");
        add("polyline", { class: "line-sub", points });
    }

    host.style.position = "relative";
    host.append(svg, tip);
}

let lastData = null;
let resizeTimer = 0;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => lastData && renderChart(lastData.series), 150);
});

function render(data) {
    lastData = data;
    const t = data.totals;
    const r = data.range;
    $("period").textContent = r.days === 1
        ? `${r.to}（今日・集計中）`
        : `${r.from} 〜 ${r.to}（${r.days}日間・今日を含む）`;

    $("kpi-pv").textContent = t.pv.toLocaleString();
    $("kpi-sessions").textContent = t.sessions.toLocaleString();
    $("kpi-sections").textContent = t.avgSections.toFixed(1);
    $("kpi-works").textContent = t.workClicks.toLocaleString();
    $("kpi-works-sub").textContent = t.sessions ? `訪問あたり ${(t.workClicks / t.sessions).toFixed(2)}回` : "訪問あたり -";
    setDelta($("kpi-pv-delta"), t.pv, t.prevPv, r.days);
    setDelta($("kpi-sessions-delta"), t.sessions, t.prevSessions, r.days);

    const status = $("status");
    status.hidden = t.pv > 0;
    status.textContent = "この期間の記録はまだありません。ポートフォリオに計測コードが入っていれば、アクセスがあり次第ここに表示されます。";

    renderChart(data.series);
    renderSections(data.sections);
    renderRank("works", data.works.map((row) => ({ name: row.name, value: row.count })), "回", "まだ作品のクリックはありません");
    renderRank("plays", data.plays.map((row) => ({ name: row.name, value: row.count })), "回");
    renderRank("referrers", data.referrers.map((row) => ({ name: row.name, value: row.sessions })), "訪問");
    renderRank("devices", data.devices.map((row) => ({ name: DEVICE_LABEL[row.name] || row.name, value: row.sessions })), "訪問");
    renderRank("countries", data.countries.map((row) => ({ name: row.name, value: row.sessions })), "訪問");

    const split = $("device-split");
    split.replaceChildren();
    const deviceTotal = data.devices.reduce((sum, row) => sum + row.sessions, 0);
    data.devices.forEach((row) => {
        const part = el("span");
        part.style.width = `${deviceTotal ? (row.sessions / deviceTotal) * 100 : 0}%`;
        part.title = `${DEVICE_LABEL[row.name] || row.name} ${row.sessions}`;
        split.append(part);
    });

    const actions = [
        ...data.photos.map((row) => ({ name: `${ACTION_LABEL.photo_open}：${row.name}`, value: row.count })),
        ...data.videos.map((row) => ({ name: `${ACTION_LABEL.video_play}：${row.name}`, value: row.count })),
        ...data.ui.map((row) => ({ name: `${ACTION_LABEL.ui_open}：${row.name}`, value: row.count })),
    ].sort((a, b) => b.value - a.value);
    renderRank("actions", actions, "回");

    const links = [
        ...data.contact.map((row) => ({ name: `連絡：${row.name}`, value: row.count })),
        ...data.outbound.map((row) => ({ name: row.name, value: row.count })),
    ].sort((a, b) => b.value - a.value);
    renderRank("links", links, "回");
}

async function load(days) {
    currentDays = days;
    try {
        localStorage.setItem("pa-days", String(days));
    } catch { /* storage unavailable */ }
    document.querySelectorAll(".range button").forEach((button) => {
        button.setAttribute("aria-pressed", String(Number(button.dataset.days) === days));
    });

    const response = await fetch(`/api/summary?days=${days}`, { cache: "no-store" });
    if (response.status === 401) {
        location.href = "/login";
        return;
    }
    if (!response.ok) {
        $("status").hidden = false;
        $("status").textContent = "データの読み込みに失敗しました。時間をおいて再読み込みしてください。";
        return;
    }
    render(await response.json());
}

document.querySelectorAll(".range button").forEach((button) => {
    button.addEventListener("click", () => load(Number(button.dataset.days)));
});

$("report-button").addEventListener("click", async () => {
    const button = $("report-button");
    button.disabled = true;
    button.textContent = "送信中…";
    try {
        const response = await fetch("/api/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        const result = await response.json();
        button.textContent = result.sent ? "送信しました ✓" : "Webhook未設定";
    } catch {
        button.textContent = "送信に失敗";
    }
    setTimeout(() => {
        button.disabled = false;
        button.textContent = "日報テスト";
    }, 2500);
});

load([1, 7, 30, 90].includes(currentDays) ? currentDays : 7);
