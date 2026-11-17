// Draws T3 Deck key images (144x144) and touch-strip segments (200x100) as SVG and
// rasterises them with resvg (WASM). The build uses the same code for the profile
// images, so keys look the same before and after the plugin starts.
import { Resvg, initWasm } from "@resvg/resvg-wasm";

export const C = {
	bg0: "#24272d",
	bg1: "#131518",
	text: "#f2f2f2",
	dim: "#8a8f98",
	faint: "#4a4f58",
	brand: "#9d8cff",
	input: "#f5a142", // needs you (question or approval)
	failed: "#f2665e",
	done: "#3ec7a5",
	working: "#4f9cf5",
	idle: "#8a8f98",
};

export const STATE_COLOR = { input: C.input, failed: C.failed, limited: C.failed, done: C.done, working: C.working, idle: C.idle };
export const STATE_WORD = { input: "needs you", failed: "failed", limited: "usage limit", done: "done", working: "working", idle: "idle" };

let ready = false;
let fonts = [];

export async function initRender(wasm, fontBuffers) {
	if (!ready) {
		await initWasm(wasm);
		ready = true;
	}
	fonts = fontBuffers.map((b) => new Uint8Array(b));
}

export function renderPng(svg, width) {
	const r = new Resvg(svg, {
		fitTo: { mode: "width", value: width },
		font: { fontBuffers: fonts, defaultFontFamily: "Inter", loadSystemFonts: false },
		shapeRendering: 2,
		textRendering: 1,
	});
	return Buffer.from(r.render().asPng());
}

export const pngDataUrl = (svg, width = 144) => "data:image/png;base64," + renderPng(svg, width).toString("base64");

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Inter is about 0.56 em wide on average for mixed text.
const textW = (s, size) => String(s).length * size * 0.56;

/** Greedy word wrap into at most `max` lines of `chars` characters; the last line gets an ellipsis. */
export function wrap(text, chars, max) {
	const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	const lines = [];
	let cur = "";
	for (let w of words) {
		while (w.length > chars) {
			// A very long word: break it.
			if (cur) {
				lines.push(cur);
				cur = "";
			}
			lines.push(w.slice(0, chars));
			w = w.slice(chars);
		}
		if (!cur) cur = w;
		else if ((cur + " " + w).length <= chars) cur += " " + w;
		else {
			lines.push(cur);
			cur = w;
		}
	}
	if (cur) lines.push(cur);
	if (lines.length > max) {
		const keep = lines.slice(0, max);
		keep[max - 1] = keep[max - 1].slice(0, chars - 1).replace(/\s+$/, "") + "…";
		return keep;
	}
	return lines;
}

const fit = (s, maxW, size) => {
	s = String(s ?? "");
	if (textW(s, size) <= maxW) return s;
	let n = Math.max(1, Math.floor(maxW / (size * 0.56)) - 1);
	return s.slice(0, n).replace(/\s+$/, "") + "…";
};

const keyOpen = (accent = null, dim = false) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
	`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dim ? "#1d1f23" : C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient></defs>` +
	`<rect width="144" height="144" rx="18" fill="url(#g)"/>` +
	(accent ? `<rect x="0" y="0" width="144" height="8" rx="4" fill="${accent}"/>` : "");

const t = (x, y, s, size, fill, weight = 600, anchor = "middle") =>
	`<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

const dot = (x, y, r, fill) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;

// ------------------------------------------------------------------ glyphs (own drawings)

/** Small line-art glyphs, drawn in a 48x48 box. */
export function glyph(name, x, y, size, fg = "#fff", acc = C.brand) {
	const s = size / 48;
	const g = (body) => `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${fg}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
	switch (name) {
		case "stop":
			return g(`<rect x="10" y="10" width="28" height="28" rx="5" fill="${acc}" stroke="none"/>`);
		case "check":
			return g(`<circle cx="24" cy="24" r="19" stroke="${acc}"/><path d="M15 25l6 6 12-13"/>`);
		case "plus":
			return g(`<path d="M24 9v30M9 24h30"/>`);
		case "reply":
			return g(`<path d="M8 12h32v20H22l-9 8v-8H8z" stroke="${acc}"/><path d="M15 20h18M15 26h11"/>`);
		case "open":
			return g(`<rect x="7" y="11" width="30" height="30" rx="5"/><path d="M25 7h16v16M41 7L22 26" stroke="${acc}"/>`);
		case "next":
			return g(`<path d="M14 10l14 14-14 14" stroke="${acc}"/><path d="M28 10l14 14-14 14"/>`);
		case "prev":
			return g(`<path d="M34 10L20 24l14 14" stroke="${acc}"/><path d="M20 10L6 24l14 14"/>`);
		case "list":
			return g(`<path d="M17 12h24M17 24h24M17 36h24"/><circle cx="8" cy="12" r="2" fill="${acc}" stroke="${acc}"/><circle cx="8" cy="24" r="2" fill="${acc}" stroke="${acc}"/><circle cx="8" cy="36" r="2" fill="${acc}" stroke="${acc}"/>`);
		case "terminal":
			return g(`<rect x="5" y="8" width="38" height="32" rx="5"/><path d="M13 18l7 6-7 6M24 31h11" stroke="${acc}"/>`);
		case "diff":
			return g(`<path d="M14 8v32M34 8v32" stroke="${fg}"/><path d="M8 16h12M28 32h12" stroke="${acc}"/><path d="M14 10v12" stroke="${acc}"/>`);
		case "search":
			return g(`<circle cx="21" cy="21" r="12"/><path d="M30 30l11 11" stroke="${acc}"/>`);
		case "sidebar":
			return g(`<rect x="5" y="8" width="38" height="32" rx="5"/><path d="M18 8v32" stroke="${acc}"/>`);
		case "palette":
			return g(`<rect x="5" y="8" width="38" height="32" rx="5"/><path d="M12 18h24" stroke="${acc}"/><path d="M12 26h16M12 33h10"/>`);
		case "pin":
			return g(`<path d="M18 6h12l-2 12 8 8H12l8-8z" stroke="${acc}"/><path d="M24 26v16"/>`);
		case "files":
			return g(`<path d="M12 6h16l10 10v26H12z"/><path d="M28 6v10h10" stroke="${acc}"/>`);
		case "model":
			return g(`<circle cx="24" cy="24" r="8" stroke="${acc}"/><path d="M24 6v8M24 34v8M6 24h8M34 24h8M11 11l6 6M31 31l6 6M37 11l-6 6M17 31l-6 6"/>`);
		case "undo":
			return g(`<path d="M12 18h18a10 10 0 010 20H18"/><path d="M18 10l-8 8 8 8" stroke="${acc}"/>`);
		case "back":
			return g(`<path d="M30 10L16 24l14 14" stroke="${acc}"/>`);
		case "forward":
			return g(`<path d="M18 10l14 14-14 14" stroke="${acc}"/>`);
		case "keyboard":
			return g(`<rect x="4" y="12" width="40" height="24" rx="4"/><path d="M11 20h2M19 20h2M27 20h2M35 20h2M14 28h20" stroke="${acc}"/>`);
		case "t3":
		default:
			return `<g transform="translate(${x} ${y}) scale(${s})"><rect x="2" y="2" width="44" height="44" rx="11" fill="${acc}"/>` +
				`<text x="24" y="32" font-family="Inter" font-size="22" font-weight="700" fill="#15131f" text-anchor="middle">T3</text></g>`;
	}
}

// ------------------------------------------------------------------ keys

/** A plain action key: glyph on top, label below. `sub` is an optional small dim line. */
export function iconKey({ glyph: name, label = "", accent = C.brand, sub = null, dim = false, active = false }) {
	const lines = String(label).split("\n").flatMap((l) => wrap(l, 11, 2)).slice(0, 2);
	const size = lines.some((l) => l.length > 9) ? 20 : 23;
	const two = lines.length > 1;
	const gs = sub && two ? 44 : 52;
	const top = sub ? (two ? 10 : 18) : two ? 16 : 24;
	let out = keyOpen(active ? accent : null, dim);
	out += glyph(name, 72 - gs / 2, top, gs, dim ? C.dim : "#fff", accent);
	const y0 = !two ? 106 : sub ? 84 : 94;
	lines.forEach((l, i) => (out += t(72, y0 + i * (size + 3), l, size, dim ? C.dim : C.text, 600)));
	if (sub) out += t(72, 136, fit(sub, 130, 14), 14, C.dim, 500);
	return out + "</svg>";
}

/**
 * The status light. `c` = {input, failed, done, working}, `online`, `pulse` (0/1 for the
 * two blink frames when there is something new).
 */
export function statusKey({ c = {}, online = true, pulse = 0, note = null }) {
	if (!online) {
		let out = keyOpen(null, true);
		out += glyph("t3", 72 - 26, 22, 52, "#fff", C.faint);
		out += t(72, 106, "T3 offline", 21, C.dim, 600);
		if (note) out += t(72, 130, fit(note, 132, 14), 14, C.dim, 500);
		return out + "</svg>";
	}
	const rows = [
		["input", c.input, "need you"],
		["failed", c.failed, "failed"],
		["done", c.done, "done"],
		["working", c.working, "working"],
	].filter((r) => r[1] > 0);
	const urgent = rows[0]?.[0];
	const ring = urgent && urgent !== "working" ? STATE_COLOR[urgent] : null;
	let out = keyOpen(null);
	if (ring) out += `<rect x="3" y="3" width="138" height="138" rx="16" fill="none" stroke="${ring}" stroke-width="${pulse ? 6 : 3}" opacity="${pulse ? 1 : 0.55}"/>`;
	if (!rows.length) {
		out += glyph("t3", 72 - 24, 20, 48, "#fff", C.brand);
		out += t(72, 98, "All clear", 22, C.text, 600);
		out += t(72, 124, "nothing waiting", 15, C.dim, 500);
		return out + "</svg>";
	}
	// Up to three rows: "● 2 need you".
	const shown = rows.slice(0, 3);
	const gap = shown.length === 1 ? 0 : shown.length === 2 ? 40 : 36;
	const y0 = 72 - ((shown.length - 1) * gap) / 2;
	if (shown.length < 3) out += glyph("t3", 8, 8, 22, "#fff", C.brand);
	shown.forEach(([state, n, word], i) => {
		const y = y0 + i * gap + (shown.length === 1 ? 4 : 0);
		const big = shown.length === 1;
		out += dot(20, y - (big ? 12 : 8), big ? 9 : 7, STATE_COLOR[state]);
		out += t(36, y + (big ? 2 : 0), String(n), big ? 40 : 28, STATE_COLOR[state], 700, "start");
		const nx = 36 + textW(String(n), big ? 40 : 28) + 6;
		out += t(nx, y - (big ? 2 : 0), word, big ? 19 : 17, C.text, 600, "start");
	});
	if (shown.length === 1) out += t(72, 128, rows[0][0] === "working" ? "agents running" : "press to open", 15, C.dim, 500);
	return out + "</svg>";
}

/** One thread: colored state band, title, project. `empty` draws a quiet blank slot. */
export function threadKey({ title = "", state = "idle", project = "", ago = "", slot = null, empty = false, offline = false, pulse = 0 }) {
	if (empty || offline) {
		let out = keyOpen(null, true);
		out += t(72, 70, offline ? "T3 offline" : "—", offline ? 18 : 30, C.faint, 600);
		if (slot != null && !offline) out += t(72, 104, `slot ${slot}`, 15, C.faint, 500);
		return out + "</svg>";
	}
	const col = STATE_COLOR[state] || C.idle;
	let out = keyOpen(null);
	out += `<rect x="0" y="0" width="144" height="30" rx="14" fill="${col}" opacity="${state === "idle" ? 0.35 : pulse ? 1 : 0.9}"/><rect x="0" y="16" width="144" height="14" fill="${col}" opacity="${state === "idle" ? 0.35 : pulse ? 1 : 0.9}"/>`;
	const word = (STATE_WORD[state] || state).toUpperCase();
	out += t(10, 22, word, 15, state === "idle" ? C.text : "#101214", 700, "start");
	if (ago) out += t(134, 22, ago, 14, state === "idle" ? C.text : "#101214", 600, "end");
	const lines = wrap(title || "Untitled", 12, 3);
	lines.forEach((l, i) => (out += t(9, 56 + i * 24, l, 20, C.text, 600, "start")));
	if (project) out += t(9, 134, fit(project, 126, 14), 14, C.dim, 500, "start");
	return out + "</svg>";
}

/** A quick-reply key: the text to send, and who gets it. */
export function replyKey({ text = "", target = "", dim = false }) {
	let out = keyOpen(null, dim);
	out += glyph("reply", 10, 10, 30, "#fff", C.brand);
	const lines = wrap(text || "…", 12, 3);
	const size = lines.length >= 3 ? 19 : 22;
	const y0 = lines.length === 1 ? 84 : lines.length === 2 ? 74 : 64;
	lines.forEach((l, i) => (out += t(72, y0 + i * (size + 4), l, size, dim ? C.dim : C.text, 600)));
	out += t(72, 134, fit(target ? "→ " + target : "no thread", 132, 13), 13, C.dim, 500);
	return out + "</svg>";
}

// ------------------------------------------------------------------ touch strip (200x100)

const stripOpen = () => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#000"/>`;

/** A thread on the touch strip: header (caption + position), title, state line. */
export function stripThread({ caption = "Threads", pos = "", title = "", state = "idle", sub = "", empty = false, flash = null }) {
	let out = stripOpen();
	out += t(8, 18, caption.toUpperCase(), 13, C.brand, 700, "start");
	if (pos) out += t(192, 18, pos, 13, C.dim, 600, "end");
	if (flash) {
		out += t(100, 64, flash, 24, C.done, 700);
		return out + "</svg>";
	}
	if (empty) {
		out += t(100, 62, title || "nothing here", 18, C.dim, 600);
		return out + "</svg>";
	}
	const lines = wrap(title || "Untitled", 18, 2);
	lines.forEach((l, i) => (out += t(8, 44 + i * 21, l, 18, C.text, 600, "start")));
	const col = STATE_COLOR[state] || C.idle;
	out += dot(13, 87, 5, col);
	out += t(24, 92, fit(`${STATE_WORD[state] || state}${sub ? " · " + sub : ""}`, 170, 14), 14, col, 600, "start");
	return out + "</svg>";
}

/** A canned reply on the touch strip, with the thread it goes to. */
export function stripReply({ text = "", target = "", pos = "", flash = null }) {
	let out = stripOpen();
	out += t(8, 18, "REPLY", 13, C.brand, 700, "start");
	if (pos) out += t(192, 18, pos, 13, C.dim, 600, "end");
	if (flash) {
		out += t(100, 64, flash, 24, flash === "Sent" ? C.done : C.failed, 700);
		return out + "</svg>";
	}
	const lines = wrap(text || "…", 17, 2);
	lines.forEach((l, i) => (out += t(8, 46 + i * 23, l, 20, C.text, 600, "start")));
	out += t(8, 93, fit(target ? "→ " + target : "no thread to send to", 186, 13), 13, C.dim, 500, "start");
	return out + "</svg>";
}

/** The dial's icon in the Stream Deck app's action list and on the strip edge. */
export function dialIconSvg(name) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><circle cx="72" cy="72" r="68" fill="#1b1d21"/><circle cx="72" cy="72" r="66" fill="none" stroke="#3a3e46" stroke-width="3"/>${glyph(name, 36, 36, 72, "#fff", C.brand)}</svg>`;
}

/** Relative time, short: "now", "4m", "3h", "2d". */
export function ago(iso, now = Date.now()) {
	const ms = now - Date.parse(iso || "");
	if (!Number.isFinite(ms)) return "";
	const m = Math.floor(ms / 60000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
