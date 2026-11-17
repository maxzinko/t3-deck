// Draws every built profile as it would look on the deck, with sample threads, one image
// per deck model: docs/layout-<deck>.png.
//   node test/layouts.mjs        (build first: node tools/build.mjs)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DECKS, PROFILES, profileName } from "../src/decks.js";
import { SHORTCUTS } from "../src/actions.js";
import * as R from "../src/render.js";
import { unzipBuffer } from "../tools/zip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SD = path.join(ROOT, "com.coreloop.t3.sdPlugin");
await R.initRender(fs.readFileSync(path.join(SD, "bin", "resvg.wasm")), ["Inter-Medium", "Inter-SemiBold", "Inter-Bold"].map((f) => fs.readFileSync(path.join(SD, "fonts", `${f}.ttf`))));

const THREADS = [
	["Which database should we use?", "input", "now"],
	["Fix the login redirect loop", "done", "2m"],
	["Add dark mode to the settings page", "working", "12m"],
	["Refactor the API client", "failed", "1h"],
	["Write the release notes", "working", "3m"],
	["Speed up the test suite", "done", "25m"],
	["Upgrade to React 19", "idle", "2h"],
	["Clean up old feature flags", "idle", "1d"],
];
const PROJECTS = ["web-app", "api", "web-app", "api", "docs", "web-app", "web-app", "api"];
const CURRENT = "Fix the login redirect loop";

function key(a) {
	const s = a.Settings || {};
	switch (a.UUID.split(".").slice(3).join(".")) {
		case "status":
			return R.statusKey({ c: { input: 1, failed: 1, done: 2, working: 2 } });
		case "thread": {
			const t = THREADS[(Number(s.slot) || 1) - 1];
			return t ? R.threadKey({ title: t[0], state: t[1], ago: t[2], project: PROJECTS[(Number(s.slot) || 1) - 1] }) : R.threadKey({ empty: true, slot: s.slot });
		}
		case "reply":
			return R.replyKey({ text: s.text || "Continue", target: CURRENT });
		case "stop":
			return R.iconKey({ glyph: "stop", label: "Stop", accent: R.C.faint, sub: CURRENT, dim: true });
		case "settle":
			return R.iconKey({ glyph: "check", label: "Mark done", accent: R.C.done, sub: CURRENT });
		case "new":
			return R.iconKey({ glyph: "plus", label: "New thread", accent: R.C.brand });
		case "open":
			return R.iconKey({ glyph: "t3", label: "T3 Code", accent: R.C.brand });
		case "shortcut": {
			const [label, g] = SHORTCUTS[s.command] || [s.command, "keyboard"];
			return R.iconKey({ glyph: g, label, accent: R.C.brand });
		}
	}
	return null;
}

function strip(a) {
	const kind = a.UUID.split(".").pop();
	if (kind === "threads") return R.stripThread({ caption: "Threads", pos: "1/8", title: THREADS[0][0], state: "input", sub: "now · web-app" });
	if (kind === "reply") return R.stripReply({ text: "Continue", target: CURRENT, pos: "1/5" });
	if (kind === "nav") return R.stripThread({ caption: "Thread", title: CURRENT, state: "done", sub: "web-app" });
	return null;
}

// Your own keys go in the empty slots.
const EMPTY = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect x="2" y="2" width="140" height="140" rx="22" fill="none" stroke="#5a5f68" stroke-width="3" stroke-dasharray="10 8"/><text x="72" y="80" fill="#7a7f88" font-family="Inter" font-weight="600" font-size="17" text-anchor="middle">your key</text></svg>`;
const EMPTY_STRIP = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="2" y="2" width="196" height="96" rx="8" fill="none" stroke="#5a5f68" stroke-width="2" stroke-dasharray="8 6"/><text x="100" y="56" fill="#7a7f88" font-family="Inter" font-weight="600" font-size="15" text-anchor="middle">your dial</text></svg>`;

const K = 96; // drawn key size
const G = 10;
for (const deck of DECKS) {
	const pages = [];
	for (const profile of PROFILES) {
		const name = profileName(profile, deck.type);
		const entries = unzipBuffer(fs.readFileSync(path.join(SD, `${name}.streamDeckProfile`)));
		const top = JSON.parse(entries.find((e) => e.name.split("/").length === 2).data);
		const B32 = "0123456789ABCDEFGHIJKLMNOPQRSTVW";
		const compact = (uuid) => {
			const bits = BigInt("0x" + uuid.replace(/-/g, "")).toString(2).padStart(128, "0") + "00";
			let o = "";
			for (let i = 0; i < 130; i += 5) o += B32[parseInt(bits.slice(i, i + 5), 2)];
			return o + "Z";
		};
		top.Pages.Pages.forEach((uuid, i) => {
			const m = JSON.parse(entries.find((e) => e.name.includes(`/${compact(uuid)}/`)).data);
			pages.push({ title: `${name}${top.Pages.Pages.length > 1 ? ` · page ${i + 1}` : ""}`, m });
		});
	}
	const pw = deck.cols * (K + G) - G;
	const stripH = deck.dials ? Math.round(((pw / deck.dials - G) * 100) / 200) + G : 0;
	const ph = 34 + deck.rows * (K + G) - G + stripH;
	const W = pages.length * (pw + 40) + 40 - 40 + 40;
	let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${ph + 50}"><rect width="100%" height="100%" fill="#2a2c30"/>`;
	pages.forEach((p, i) => {
		const x0 = 20 + i * (pw + 40);
		const y0 = 20;
		svg += `<text x="${x0}" y="${y0 + 14}" fill="#e8e8e8" font-family="Inter" font-weight="700" font-size="16">${R.esc(p.title)}</text>`;
		const pad = p.m.Controllers.find((c) => c.Type === "Keypad")?.Actions || {};
		for (let r = 0; r < deck.rows; r++) {
			for (let c = 0; c < deck.cols; c++) {
				const a = pad[`${c},${r}`];
				const img = (a && key(a)) || EMPTY;
				svg += `<image x="${x0 + c * (K + G)}" y="${y0 + 30 + r * (K + G)}" width="${K}" height="${K}" href="${R.pngDataUrl(img, 144)}"/>`;
			}
		}
		if (deck.dials) {
			const enc = p.m.Controllers.find((c) => c.Type === "Encoder")?.Actions || {};
			const sw = (pw - G * (deck.dials - 1)) / deck.dials;
			for (let d = 0; d < deck.dials; d++) {
				const a = enc[`${d},0`];
				const img = (a && strip(a)) || EMPTY_STRIP;
				svg += `<image x="${x0 + d * (sw + G)}" y="${y0 + 30 + deck.rows * (K + G)}" width="${sw}" height="${sw / 2}" href="${R.pngDataUrl(img, 200)}"/>`;
			}
		}
	});
	svg += "</svg>";
	const out = path.join(ROOT, "docs", `layout-${deck.id}.png`);
	fs.writeFileSync(out, R.renderPng(svg, W));
	console.log(`${deck.name}: ${path.relative(ROOT, out)}`);
}
