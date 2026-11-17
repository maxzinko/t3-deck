// Generates the T3 Deck profiles, a "Desktop" and a "Code" profile for each deck in
// src/decks.js:
//   T3 Deck Desktop   shown for every program except T3 Code (the empty keys are yours)
//   T3 Deck Code      shown while T3 Code is in front
// Keys of this plugin carry {deckProfile, deckPage} so the plugin knows what is on screen.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DECKS, profileName } from "../src/decks.js";
import { zipBuffer } from "./zip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SD = path.join(ROOT, "com.coreloop.t3.sdPlugin");
const UUID = "com.coreloop.t3";

// ------------------------------------------------------------------ layout helpers
const status = () => ({ a: "status" });
const slot = (n) => ({ a: "thread", s: { slot: n } });
const slots = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => slot(from + i));
const stop = () => ({ a: "stop" });
const settle = () => ({ a: "settle" });
const newThread = () => ({ a: "new" });
const open = () => ({ a: "open" });
const reply = (text) => ({ a: "reply", s: { text } });
const shortcut = (command) => ({ a: "shortcut", s: { command } });
const dial = (kind, s = {}) => ({ a: `dial.${kind}`, s });
const empty = (n) => Array(n).fill(null); // keys left for your own actions

const THREADS_DIAL = dial("threads");
const REPLY_DIAL = dial("reply");
const NAV_DIAL = dial("nav");
const ACT = [status(), stop(), settle(), newThread()];
const PANELS = [shortcut("commandPalette.toggle"), shortcut("sidebar.toggle"), shortcut("terminal.toggle"), shortcut("filePicker.toggle")];
const PREV_NEXT = [shortcut("thread.previous"), shortcut("thread.next")];

// Keys run left to right, top row first. null = an empty key.
const LAYOUTS = {
	// 4x2 keys and 4 dials. The touch strip swipes between pages.
	plus: {
		Desktop: [{ name: "Home", keys: [status(), ...slots(1, 3), ...empty(4)], dials: [null, null, null, THREADS_DIAL] }],
		Code: [
			{ name: "Act", keys: [...ACT, ...PANELS], dials: [NAV_DIAL, REPLY_DIAL, THREADS_DIAL, null] },
			{ name: "Threads", keys: [status(), ...slots(1, 7)], dials: [NAV_DIAL, REPLY_DIAL, THREADS_DIAL, null] },
		],
	},
	// 5x3 keys, no dials: thread keys and replies take the dials' jobs.
	mk2: {
		Desktop: [{ name: "Home", keys: [status(), ...slots(1, 4), ...empty(10)] }],
		Code: [
			{
				name: "Act",
				keys: [...ACT, PANELS[0], ...PREV_NEXT, ...PANELS.slice(1), reply("Continue"), reply("Yes, do it"), ...slots(1, 3)],
			},
		],
	},
	// 8x4 keys, no dials.
	xl: {
		Desktop: [{ name: "Home", keys: [status(), ...slots(1, 7), ...empty(24)] }],
		Code: [
			{
				name: "Act",
				keys: [
					...ACT,
					...PANELS,
					...PREV_NEXT,
					shortcut("navigation.back"),
					shortcut("navigation.forward"),
					shortcut("chat.find"),
					shortcut("projectSearch.toggle"),
					shortcut("thread.pin"),
					open(),
					...slots(1, 8),
					reply("Continue"),
					reply("Yes, do it"),
					reply("Run the tests and fix what fails"),
					reply("Commit your work"),
					reply("Explain what you changed"),
					...empty(3),
				],
			},
		],
	},
};

// ------------------------------------------------------------------ writer (Stream Deck profile export format 2.0)
const B32 = "0123456789ABCDEFGHIJKLMNOPQRSTVW";
function compactId(uuid) {
	const bits = BigInt("0x" + uuid.replace(/-/g, "")).toString(2).padStart(128, "0") + "00";
	let out = "";
	for (let i = 0; i < 130; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
	return out + "Z";
}
function uuidFrom(seed) {
	const h = crypto.createHash("sha1").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const NAMES = { status: "T3 Status", thread: "Thread", reply: "Quick Reply", stop: "Stop", settle: "Mark Done", new: "New Thread", open: "Open T3 Code", shortcut: "T3 Shortcut", "dial.threads": "Threads Dial", "dial.reply": "Reply Dial", "dial.nav": "Thread Navigator" };

function buildProfile(deck, profile, pages) {
	const name = profileName(profile, deck.type);
	// The Stream Deck + seeds stay as they were, so its page ids don't change.
	const seed = deck.id === "plus" ? `t3-deck/${profile}` : `t3-deck/${deck.id}/${profile}`;
	let n = 0;
	const out = [];
	pages.forEach((pg, i) => {
		const deckPage = i + 1;
		const keys = pg.keys || [];
		const dials = pg.dials || [];
		if (keys.length > deck.cols * deck.rows) throw new Error(`${name} page ${deckPage}: ${keys.length} keys, the deck has ${deck.cols * deck.rows}`);
		if (dials.length > deck.dials) throw new Error(`${name} page ${deckPage}: ${dials.length} dials, the deck has ${deck.dials}`);
		const p = { uuid: uuidFrom(`${seed}/page${i}`), keypad: {}, encoder: {} };
		const place = (item, controller, pos) => {
			if (!item) return;
			// No stored image: the plugin draws these keys (a stored image would win over it).
			(controller === "Keypad" ? p.keypad : p.encoder)[pos] = {
				ActionID: uuidFrom(`${seed}/action/${n++}`),
				LinkedTitle: true,
				Name: NAMES[item.a],
				Settings: { ...(item.s || {}), deckProfile: profile, deckPage },
				State: 0,
				States: [controller === "Keypad" ? { ShowTitle: false } : {}],
				UUID: `${UUID}.${item.a}`,
			};
		};
		keys.forEach((k, j) => place(k, "Keypad", `${j % deck.cols},${Math.floor(j / deck.cols)}`));
		dials.forEach((d, j) => place(d, "Encoder", `${j},0`));
		out.push(p);
	});
	const def = { uuid: uuidFrom(`${seed}/default`), keypad: {}, encoder: {} };
	const root = `${uuidFrom(`${seed}/profile`).toUpperCase()}.sdProfile`;
	const entries = [
		{
			name: `${root}/manifest.json`,
			data: JSON.stringify({ Device: { Model: deck.model, UUID: "" }, Name: name, Pages: { Current: out[0].uuid, Default: def.uuid, Pages: out.map((p) => p.uuid) }, Version: "2.0" }),
		},
	];
	for (const p of [...out, def]) {
		const controllers = [{ Actions: p.keypad, Type: "Keypad" }];
		if (deck.dials) controllers.push({ Actions: p.encoder, Type: "Encoder" });
		entries.push({ name: `${root}/Profiles/${compactId(p.uuid)}/manifest.json`, data: JSON.stringify({ Controllers: controllers, Icon: "", Name: "" }) });
	}
	return { name, zip: zipBuffer(entries) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	for (const f of fs.readdirSync(SD)) if (f.endsWith(".streamDeckProfile")) fs.rmSync(path.join(SD, f));
	for (const deck of DECKS) {
		for (const [profile, pages] of Object.entries(LAYOUTS[deck.id])) {
			const { name, zip } = buildProfile(deck, profile, pages);
			fs.writeFileSync(path.join(SD, `${name}.streamDeckProfile`), zip);
			console.log(`profile ${name}: ${pages.length} page${pages.length > 1 ? "s" : ""} (${pages.map((p) => p.name).join(", ")})`);
		}
	}
}
