// Runs bin/fgwatch.exe (a tiny Windows helper) and turns its output into "app" events:
// one each time a different window comes to the front. It also sends key presses
// for the T3 Code shortcut keys and dials (only while T3 Code is in front).
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import readline from "node:readline";
import { profileName } from "./decks.js";

export class Foreground extends EventEmitter {
	constructor(exe, log) {
		super();
		this.exe = exe;
		this.log = log;
		this.proc = null;
		this.current = null; // last window info
		this.restarts = 0;
	}

	start() {
		if (!fs.existsSync(this.exe) || (process.platform !== "win32" && !/\.m?js$/i.test(this.exe))) {
			this.log?.warn(`foreground watcher not available (${this.exe})`);
			return;
		}
		this.#spawn();
	}

	#spawn() {
		const script = /\.m?js$/i.test(this.exe); // a stand-in watcher script (tests)
		const p = spawn(script ? process.execPath : this.exe, script ? [this.exe] : [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		this.proc = p;
		readline.createInterface({ input: p.stdout }).on("line", (line) => {
			try {
				const w = JSON.parse(line);
				this.current = w;
				this.emit("window", w);
			} catch {}
		});
		p.on("exit", (code) => {
			if (this.proc !== p) return;
			this.proc = null;
			if (this.stopped) return;
			this.restarts++;
			this.log?.warn(`foreground watcher exited (${code}); restarting`);
			setTimeout(() => this.#spawn(), Math.min(30000, 1000 * this.restarts));
		});
		p.on("error", (e) => this.log?.error(`foreground watcher: ${e.message}`));
	}

	stop() {
		this.stopped = true;
		try {
			this.proc?.stdin.end();
		} catch {}
	}

	/** Bring the first window of a program whose file name starts with `prefix` to the front. */
	focus(prefix) {
		if (!this.proc) return false;
		this.proc.stdin.write(`focus ${prefix}\n`);
		return true;
	}

	/** Press a key combination such as "ctrl+shift+]". */
	keys(combo) {
		if (!this.proc) return false;
		this.proc.stdin.write(`keys ${combo}\n`);
		return true;
	}
}

// ------------------------------------------------------------------ app rules

/**
 * Rules are lines of `pattern = target`, first match wins:
 *   obs64.exe = ignore            leave the deck alone while OBS is in front
 *   T3 Code*.exe = Code           switch to the "T3 Deck Code" profile
 *   * = Desktop                   "T3 Deck Desktop", on the page you used last
 * A page number picks the page: `chrome.exe = Desktop 2`.
 * A pattern matches the program file name (case-insensitive, * is a wildcard), or the
 * window class when written `class:Name`. Lines starting with # are comments.
 */
export const DEFAULT_RULES = [
	"# Program = profile [page]. First match wins. Profiles: Desktop, Code, ignore.",
	"# Example: obs64.exe = ignore",
	"T3 Code*.exe = Code",
	"* = Desktop",
].join("\n");

// Windows that come and go on their own (Alt+Tab, Start, overlays, the Stream Deck
// app itself). They never switch the deck.
const ALWAYS_IGNORE = [
	"StreamDeck.exe",
	"ShellExperienceHost.exe",
	"StartMenuExperienceHost.exe",
	"SearchHost.exe",
	"SearchApp.exe",
	"LockApp.exe",
	"TextInputHost.exe",
	"ShellHost.exe",
	"PowerToys*.exe",
	"Wispr Flow.exe",
	"fgwatch.exe",
	"class:XamlExplorerHostIslandWindow",
	"class:ForegroundStaging",
	"class:MultitaskingViewFrame",
	"class:TaskSwitcherWnd",
	"class:NotifyIconOverflowWindow",
	"class:TopLevelWindowForOverflowXamlIsland",
	"class:Windows.UI.Core.CoreWindow",
	"class:#32768", // context menus
];

const toRe = (pat) => new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");

function compile(lines) {
	const out = [];
	for (const raw of String(lines || "").split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, "").trim();
		if (!line) continue;
		const eq = line.lastIndexOf("=");
		if (eq < 0) continue;
		const pat = line.slice(0, eq).trim();
		const [profile, page] = line.slice(eq + 1).trim().split(/\s+/);
		if (!pat || !profile) continue;
		const cls = pat.toLowerCase().startsWith("class:");
		out.push({ cls, re: toRe(cls ? pat.slice(6).trim() : pat), profile, page: page ? Math.max(1, Number(page) || 1) : null });
	}
	return out;
}

const ignored = compile(ALWAYS_IGNORE.map((p) => `${p} = ignore`).join("\n"));

/**
 * What a window asks for:
 *   "transient"        a passing window (Alt+Tab, Start, the Stream Deck app): forget it
 *   null               a real app a rule leaves alone ("= ignore"): the deck stays as it is
 *   {profile, page}    switch to this T3 Deck profile (page is 1-based, or null for "last used")
 */
export function targetFor(win, rulesText) {
	if (!win || (!win.exe && !win.cls)) return "transient";
	const match = (r) => (r.cls ? r.re.test(win.cls || "") : r.re.test(win.exe || ""));
	if (ignored.some(match)) return "transient";
	for (const r of compile(rulesText || DEFAULT_RULES)) {
		if (!match(r)) continue;
		if (r.profile.toLowerCase() === "ignore") return null;
		return { profile: r.profile, page: r.page };
	}
	return null;
}

/**
 * Decides when to switch. It follows the program in front, not each window: going from
 * one Chrome window to another, or through a passing window and back, does nothing, so
 * a profile you picked by hand stays until you really change apps.
 */
export class Switcher {
	constructor({ switchTo, devices, log }) {
		this.switchTo = switchTo; // (deviceId, profileName, pageIndex0) => Promise
		this.devices = devices; // () => [{id, type}] of the connected decks
		this.log = log;
		this.prefix = "T3 Deck ";
		this.enabled = true;
		this.rules = DEFAULT_RULES;
		this.lastApp = null;
		this.shown = new Map(); // device -> {profile, page, ids:Set}
		this.lastPage = new Map(); // profile -> page (1-based)
		this.timer = null;
	}

	configure({ enabled, rules }) {
		if (enabled !== undefined) this.enabled = enabled !== false;
		if (rules !== undefined) this.rules = rules || DEFAULT_RULES;
	}

	/** One of our keys appeared; its settings say which profile and page it lives on. */
	appeared(device, id, profile, page) {
		if (!profile) return;
		let s = this.shown.get(device);
		if (!s || s.profile !== profile || s.page !== page) {
			s = { profile, page, ids: new Set() };
			this.shown.set(device, s);
			this.log?.info(`deck shows ${this.prefix}${profile} page ${page}`);
		}
		s.ids.add(id);
		this.lastPage.set(profile, page);
	}

	disappeared(device, id) {
		const s = this.shown.get(device);
		if (!s) return;
		s.ids.delete(id);
		if (!s.ids.size) this.shown.delete(device);
	}

	/** Apply the window in front again, as if it just came up (a device connected). */
	refresh(win) {
		this.lastApp = null;
		if (win) this.onWindow(win);
	}

	onWindow(win) {
		clearTimeout(this.timer);
		// Wait a moment: Alt+Tab and taskbar clicks pass through several windows.
		this.timer = setTimeout(() => this.#apply(win), 250);
	}

	#apply(win) {
		const target = targetFor(win, this.rules);
		if (target === "transient") return;
		const app = (win.exe || "").toLowerCase();
		// Only decks T3 Deck has profiles for can be switched.
		const devices = this.devices().filter((d) => profileName("Desktop", d.type));
		// No deck yet (the app is still starting): keep the change for refresh().
		if (!devices.length) {
			this.log?.info(`${win.exe} in front, but no Stream Deck with T3 Deck profiles yet`);
			return;
		}
		const changed = app !== this.lastApp;
		this.lastApp = app;
		if (!changed) return;
		if (!target || !this.enabled) {
			this.log?.info(`${win.exe} in front: deck left as it is${this.enabled ? "" : " (switching is off)"}`);
			return;
		}
		const page = target.page || this.lastPage.get(target.profile) || 1;
		for (const d of devices) {
			const s = this.shown.get(d.id);
			if (s && s.profile === target.profile && (!target.page || s.page === target.page)) continue;
			const name = profileName(target.profile, d.type);
			this.log?.info(`${win.exe} in front: ${name} page ${page}`);
			Promise.resolve(this.switchTo(d.id, name, page - 1)).catch((e) => this.log?.error(`switch: ${e.message}`));
		}
	}
}

/** True when the window belongs to T3 Code (so shortcut keys may be sent to it). */
export const isT3Window = (win) => /^T3 Code.*\.exe$/i.test(win?.exe || "");
