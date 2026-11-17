// T3 Deck: Stream Deck plugin entry point.
//  - T3Client keeps a live list of T3 Code threads (WebSocket push).
//  - Foreground + Switcher pick the deck profile for the program in front.
//  - The actions draw thread status and send commands.
import streamDeck from "@elgato/streamdeck";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIONS, UUID } from "./actions.js";
import { deckFor } from "./decks.js";
import { DEFAULT_RULES, Foreground, Switcher, isT3Window } from "./foreground.js";
import { initRender } from "./render.js";
import { T3Client, T3_CLI, T3_HOME, currentThread, issueToken, readRuntime } from "./t3.js";

const log = streamDeck.logger;
log.setLevel("info");
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await initRender(
	fs.readFileSync(path.join(PLUGIN_DIR, "bin", "resvg.wasm")),
	["Inter-Medium", "Inter-SemiBold", "Inter-Bold"].map((f) => fs.readFileSync(path.join(PLUGIN_DIR, "fonts", `${f}.ttf`))),
);

// ------------------------------------------------------------------ settings

// Global settings: {token, tokenExpires, tokenSession, auto, rules}. The token stays in
// the plugin; the settings page only ever sees whether there is one and when it expires.
let globals = {};
const saveGlobals = async (patch) => {
	globals = { ...globals, ...patch };
	await streamDeck.settings.setGlobalSettings(globals);
};

let lastIssue = 0;
async function newToken(reason) {
	if (Date.now() - lastIssue < 10 * 60000) throw new Error("waiting before asking T3 for another token");
	lastIssue = Date.now();
	log.info(`asking T3 Code for a Stream Deck token (${reason})`);
	const { token, expiresAt } = await issueToken();
	await saveGlobals({ token, tokenExpires: expiresAt || "" });
	log.info(`got a token, valid until ${expiresAt || "unknown"}`);
}

const client = new T3Client({ log, getToken: () => globals.token || "", onNeedToken: newToken });
client.on("status", (s, err) => log.info(`T3 ${s}${err ? `: ${err}` : ""}`));

// ------------------------------------------------------------------ foreground + profiles

// Tests swap the watcher for a script and log opened links instead of opening them.
const fg = new Foreground(process.env.T3DECK_FGWATCH || path.join(PLUGIN_DIR, "bin", "fgwatch.exe"), log);
const OPEN_LOG = process.env.T3DECK_OPEN_LOG || "";
const decks = () => [...streamDeck.devices].filter((d) => d.isConnected !== false).map((d) => ({ id: d.id, type: d.type, name: d.name }));
const switcher = new Switcher({
	switchTo: (d, name, page) => streamDeck.profiles.switchToProfile(d, name, page),
	devices: decks,
	log,
});
fg.on("window", (w) => switcher.onWindow(w));
// The device can show up after the first window report (Stream Deck starting with Windows).
streamDeck.devices.onDeviceDidConnect(() => switcher.refresh(fg.current));

const mine = (ev) => ev.action.manifestId?.startsWith(UUID);
streamDeck.actions.onWillAppear((ev) => mine(ev) && switcher.appeared(ev.action.device.id, ev.action.id, ev.payload.settings?.deckProfile, Number(ev.payload.settings?.deckPage) || 1));
streamDeck.actions.onWillDisappear((ev) => mine(ev) && switcher.disappeared(ev.action.device.id, ev.action.id));

// ------------------------------------------------------------------ opening things

// T3 Code's own processes run with ELECTRON_RUN_AS_NODE=1; anything started from one
// inherits it, and then T3 Code's exe starts as plain Node and ignores the link.
const cleanEnv = () => {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
};

function openUrl(url) {
	if (OPEN_LOG) fs.appendFileSync(OPEN_LOG, url + "\n");
	else {
		// The registered t3code: handler hands the link to the running app.
		const p = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true, env: cleanEnv() });
		p.on("error", (e) => log.error(`open ${url.split("?")[0]}: ${e.message}`));
		p.unref();
	}
	// Windows won't let a background program hand focus over, so the helper does it.
	if (url.startsWith("t3code:")) setTimeout(() => fg.focus("T3 Code"), 400);
}

let t3Exe = null;
function findT3Exe() {
	return new Promise((resolve) => {
		execFile("reg.exe", ["query", "HKCU\\Software\\Classes\\t3code\\shell\\open\\command", "/ve"], { windowsHide: true }, (err, out) => {
			const m = !err && /"([^"]+\.exe)"/i.exec(String(out));
			resolve(m ? m[1] : null);
		});
	});
}

/**
 * The first-run checklist on the T3 Status key's settings page: each step T3 Deck needs,
 * whether it works, and what to do when it doesn't. `soft` steps are warnings.
 */
async function setupChecks() {
	const win = process.platform === "win32";
	const rt = readRuntime();
	if (!t3Exe && win) t3Exe = await findT3Exe();
	const st = client.status;
	const threads = client.topThreads().length;
	const out = [
		{ id: "home", ok: fs.existsSync(T3_HOME), label: "T3 Code installed", detail: T3_HOME, fix: "Install T3 Code and start it once. T3 Deck reads its data folder (set T3CODE_HOME if yours is somewhere else)." },
		{ id: "running", ok: !!rt && st !== "offline", label: "T3 Code running", detail: st !== "offline" ? rt?.origin || "" : client.error, fix: "Start T3 Code. The keys connect by themselves a few seconds later." },
		{ id: "cli", ok: fs.existsSync(T3_CLI), label: "T3 command line", detail: T3_CLI, fix: "T3 Deck gets its access token from T3's command line (t3). It comes with T3 Code; update T3 Code if it's missing." },
		{ id: "access", ok: st === "online", label: "Signed in", detail: st === "online" ? `${threads} thread${threads === 1 ? "" : "s"}` : client.error || (globals.token ? "token stored" : "no token yet"), fix: "Press “Get a new token” below. If T3 Code refuses it, look in T3 Code ▸ Settings ▸ Sharing & access." },
		{ id: "links", ok: !!t3Exe, label: "Thread links", detail: t3Exe || "t3code:// links are not registered", fix: "Start T3 Code once, so Windows opens t3code:// links with it." },
		{ id: "watcher", ok: !!fg.proc, label: "Window watcher", detail: fg.proc ? `in front now: ${fg.current?.exe || "?"}` : "not running", fix: win ? "bin/fgwatch.exe didn't start. Antivirus software sometimes blocks it: allow it, then restart the Stream Deck app." : "Switching by program needs Windows." },
	];
	const list = decks();
	for (const d of list) {
		const deck = deckFor(d.type);
		out.push({ id: `deck-${d.id}`, ok: !!deck, soft: true, label: d.name || "Stream Deck", detail: deck ? "has T3 Deck Desktop and Code profiles" : "no T3 Deck profiles for this model", fix: "The keys and dials still work: drag them onto your own profiles. Switching by program needs a Stream Deck +, MK.2 or XL." });
	}
	if (!list.length) out.push({ id: "decks", ok: false, soft: true, label: "Stream Deck", detail: "none connected", fix: "Plug in your Stream Deck." });
	return out;
}

const ctx = Object.assign(new EventEmitter(), {
	client,
	openUrl,
	openThread(id) {
		openUrl(client.threadLink(id));
	},
	async openApp() {
		const t = currentThread(client.topThreads());
		if (t) return openUrl(client.threadLink(t.id));
		t3Exe = t3Exe || (await findT3Exe());
		if (!t3Exe) return false;
		if (OPEN_LOG) return fs.appendFileSync(OPEN_LOG, `app ${t3Exe}\n`);
		spawn(t3Exe, [], { detached: true, stdio: "ignore", env: cleanEnv() }).unref();
		setTimeout(() => fg.focus("T3 Code"), 1500);
	},
	keyFor,
	/** Press T3 Code's shortcut for a command. Brings T3 Code to the front first unless focus is false. */
	async shortcut(command, { focus = true } = {}) {
		const combo = keyFor(command);
		if (!combo) return false;
		if (!isT3Window(fg.current)) {
			if (!focus) return false;
			await ctx.openApp();
			const until = Date.now() + 2500;
			while (!isT3Window(fg.current) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
			if (!isT3Window(fg.current)) return false;
			await new Promise((r) => setTimeout(r, 150));
		}
		return fg.keys(combo);
	},
	async sendInfo() {
		await streamDeck.ui.sendToPropertyInspector({
			event: "info",
			status: client.status,
			error: client.error,
			origin: client.origin,
			threads: client.topThreads().length,
			hasToken: !!globals.token,
			tokenExpires: globals.tokenExpires || "",
			auto: globals.auto !== false,
			rules: globals.rules || DEFAULT_RULES,
			defaultRules: DEFAULT_RULES,
			front: fg.current?.exe || "",
			watcher: !!fg.proc,
			checks: await setupChecks(),
		});
	},
	async fromInspector(p) {
		if (p.event === "save") {
			await saveGlobals({ auto: p.auto !== false, rules: String(p.rules ?? "") || DEFAULT_RULES });
			switcher.configure({ enabled: globals.auto !== false, rules: globals.rules });
		} else if (p.event === "newToken") {
			lastIssue = 0;
			try {
				await newToken("asked for in the settings");
				client.reconnect();
			} catch (e) {
				log.error(e.message);
			}
		}
		await ctx.sendInfo();
	},
});

// ------------------------------------------------------------------ T3 Code shortcuts

// Defaults from T3 Code; the user's own keybindings.json wins when it names the command.
const DEFAULT_KEYS = {
	"thread.previous": "ctrl+shift+[",
	"thread.next": "ctrl+shift+]",
	"chat.new": "ctrl+n",
	"commandPalette.toggle": "ctrl+k",
	"sidebar.toggle": "ctrl+b",
	"terminal.toggle": "ctrl+j",
	"diff.toggle": "ctrl+d",
	"chat.find": "ctrl+f",
	"filePicker.toggle": "ctrl+p",
	"thread.pin": "ctrl+shift+p",
	"thread.settle": "ctrl+shift+s",
	"navigation.back": "ctrl+[",
	"navigation.forward": "ctrl+]",
	"modelPicker.toggle": "ctrl+shift+m",
	"composer.mode": "ctrl+shift+a",
	"projectSearch.toggle": "ctrl+shift+f",
	"threadPanel.toggle": "ctrl+shift+b",
	"rightPanel.toggle": "ctrl+alt+b",
	"thread.undo": "ctrl+z",
};
let userKeys = null;
let userKeysAt = 0;
function keyFor(command) {
	if (Date.now() - userKeysAt > 30000) {
		userKeysAt = Date.now();
		userKeys = {};
		try {
			const list = JSON.parse(fs.readFileSync(path.join(T3_HOME, "userdata", "keybindings.json"), "utf8"));
			for (const b of list) {
				// Skip bindings that only work inside a special focus (terminal, usage page, pickers).
				const when = String(b.when || "");
				const special = when.split("&&").map((x) => x.trim()).some((x) => x && !x.startsWith("!"));
				if (!b.command || !b.key || special || userKeys[b.command]) continue;
				userKeys[b.command] = String(b.key).toLowerCase().replace(/\bmod\b/g, "ctrl").replace(/\bcmd\b/g, "ctrl").replace(/arrow(up|down|left|right)/g, "$1");
			}
		} catch {}
	}
	return userKeys?.[command] || DEFAULT_KEYS[command] || null;
}

// ------------------------------------------------------------------ start

for (const A of ACTIONS) streamDeck.actions.registerAction(new A(ctx));

streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
	const tokenChanged = (ev.settings?.token || "") !== (globals.token || "");
	globals = ev.settings || {};
	switcher.configure({ enabled: globals.auto !== false, rules: globals.rules });
	if (tokenChanged) client.reconnect();
});

await streamDeck.connect();
globals = (await streamDeck.settings.getGlobalSettings()) || {};
switcher.configure({ enabled: globals.auto !== false, rules: globals.rules });

// Renew the token a few days before it runs out.
const expires = Date.parse(globals.tokenExpires || "");
if (globals.token && Number.isFinite(expires) && expires - Date.now() < 3 * 86400000) {
	newToken("token about to expire").catch((e) => log.warn(e.message));
}

client.start();
fg.start();
log.info("T3 Deck started");
