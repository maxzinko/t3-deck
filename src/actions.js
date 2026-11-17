// T3 Deck keys and dials. Every action reads the same live thread list from T3Client
// and redraws when it changes.
import streamDeck, { SingletonAction } from "@elgato/streamdeck";
import { counts, currentThread, inbox, stateOf, stateSince } from "./t3.js";
import { C, ago, iconKey, pngDataUrl, replyKey, statusKey, stripReply, stripThread, threadKey } from "./render.js";

export const UUID = "com.coreloop.t3";
const LONG_PRESS = 550;

// ------------------------------------------------------------------ shared helpers

/** Base for keys: keeps the visible instances, redraws on change, tells long presses apart. */
class Base extends SingletonAction {
	constructor(ctx) {
		super();
		this.ctx = ctx;
		this.visible = new Map(); // action id -> {action, settings, img}
		this.downAt = new Map();
		ctx.client.on("change", () => this.redraw());
		ctx.on?.("tick", () => this.tick?.());
	}

	async onWillAppear(ev) {
		this.visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings || {}, img: null });
		await this.#draw(ev.action.id);
	}

	onWillDisappear(ev) {
		this.visible.delete(ev.action.id);
	}

	async onDidReceiveSettings(ev) {
		const e = this.visible.get(ev.action.id);
		if (!e) return;
		e.settings = ev.payload.settings || {};
		e.img = null;
		await this.#draw(ev.action.id);
	}

	onKeyDown(ev) {
		this.downAt.set(ev.action.id, Date.now());
	}

	async onKeyUp(ev) {
		const t0 = this.downAt.get(ev.action.id) || Date.now();
		this.downAt.delete(ev.action.id);
		const s = ev.payload.settings || {};
		try {
			const ok = Date.now() - t0 >= LONG_PRESS ? await this.longPress(ev.action, s) : await this.press(ev.action, s);
			if (ok === false) await ev.action.showAlert();
		} catch (e) {
			streamDeck.logger.warn(`${this.manifestId}: ${e.message}`);
			await ev.action.showAlert();
		}
		this.redraw();
	}

	press() {}
	longPress(action, s) {
		return this.press(action, s);
	}

	/** SVG for one instance. */
	svg() {
		return "";
	}

	redraw() {
		for (const id of this.visible.keys()) this.#draw(id).catch(() => {});
	}

	async #draw(id) {
		const e = this.visible.get(id);
		if (!e) return;
		const svg = this.svg(e.settings, e);
		if (!svg || svg === e.img) return;
		e.img = svg;
		await e.action.setImage(pngDataUrl(svg));
		await e.action.setTitle("");
	}
}

const title = (t) => t?.title || "Untitled";

// ------------------------------------------------------------------ status light

export class StatusKey extends Base {
	manifestId = `${UUID}.status`;

	constructor(ctx) {
		super(ctx);
		this.ackAt = Date.now() - 10 * 60000; // things that happened in the last 10 minutes count as new
		this.frame = 0;
		setInterval(() => {
			if (!this.#fresh()) return;
			this.frame ^= 1;
			this.redraw();
		}, 700);
	}

	/** Something needs you, failed or finished since you last pressed the key. */
	#fresh() {
		if (this.ctx.client.status !== "online") return false;
		return inbox(this.ctx.client.topThreads()).some((x) => x.state !== "working" && x.state !== "idle" && Date.parse(stateSince(x.t, x.state)) > this.ackAt);
	}

	svg() {
		const cl = this.ctx.client;
		if (cl.status !== "online") return statusKey({ online: false, note: cl.status === "auth" ? "sign-in needed" : cl.status === "connecting" ? "connecting…" : "" });
		const list = inbox(cl.topThreads());
		return statusKey({ c: counts(list), pulse: this.#fresh() ? this.frame : 0 });
	}

	/** Open the thread that needs you most; with nothing waiting, open T3 Code. */
	async press() {
		this.ackAt = Date.now();
		const list = inbox(this.ctx.client.topThreads());
		const top = list.find((x) => x.state !== "idle");
		if (top) return this.ctx.openThread(top.t.id);
		return this.ctx.openApp();
	}

	async longPress() {
		this.ackAt = Date.now();
		return this.ctx.openApp();
	}

	async onPropertyInspectorDidAppear() {
		await this.ctx.sendInfo();
	}

	async onSendToPlugin(ev) {
		await this.ctx.fromInspector(ev.payload || {});
	}
}

// ------------------------------------------------------------------ thread slot

export class ThreadKey extends Base {
	manifestId = `${UUID}.thread`;

	#thread(s) {
		const n = Math.max(1, Number(s.slot) || 1);
		return inbox(this.ctx.client.topThreads())[n - 1] || null;
	}

	svg(s) {
		const cl = this.ctx.client;
		const slot = Math.max(1, Number(s.slot) || 1);
		if (cl.status !== "online") return threadKey({ offline: true });
		const x = this.#thread(s);
		if (!x) return threadKey({ empty: true, slot });
		return threadKey({ title: title(x.t), state: x.state, project: cl.projectName(x.t), ago: ago(stateSince(x.t, x.state)) });
	}

	async press(action, s) {
		const x = this.#thread(s);
		if (!x) return this.ctx.openApp();
		return this.ctx.openThread(x.t.id);
	}

	/** Long press: mark it done (settle), which takes it off the list. */
	async longPress(action, s) {
		const x = this.#thread(s);
		if (!x) return false;
		await this.ctx.client.settleThread(x.t.id);
		await action.showOk();
	}
}

// ------------------------------------------------------------------ actions on the current thread

/** The thread these keys act on: the one you looked at last (open in the app), or the top of the list. */
function targetThread(ctx, s) {
	const top = ctx.client.topThreads();
	if (s.target === "top") return inbox(top).find((x) => x.state !== "idle")?.t || null;
	return currentThread(top);
}

export class ReplyKey extends Base {
	manifestId = `${UUID}.reply`;

	svg(s) {
		const t = targetThread(this.ctx, s);
		return replyKey({ text: s.text || "Continue", target: this.ctx.client.status === "online" ? (t ? title(t) : "") : "T3 offline", dim: !t });
	}

	async press(action, s) {
		const t = targetThread(this.ctx, s);
		const text = String(s.text || "Continue").trim();
		if (!t || !text) return false;
		await this.ctx.client.sendMessage(t.id, text);
		streamDeck.logger.info(`reply sent to "${title(t)}"`);
		await action.showOk();
	}

	// A long press does the same; no surprises.
}

export class StopKey extends Base {
	manifestId = `${UUID}.stop`;

	svg(s) {
		const t = targetThread(this.ctx, s);
		const busy = t && stateOf(t) === "working";
		return iconKey({ glyph: "stop", label: "Stop", accent: busy ? C.failed : C.faint, sub: t ? title(t) : "", dim: !busy, active: busy });
	}

	async press(action, s) {
		const t = targetThread(this.ctx, s);
		if (!t || stateOf(t) !== "working") return false;
		await this.ctx.client.stopThread(t.id);
		await action.showOk();
	}
}

export class SettleKey extends Base {
	manifestId = `${UUID}.settle`;

	svg(s) {
		const t = targetThread(this.ctx, s);
		return iconKey({ glyph: "check", label: "Mark done", accent: C.done, sub: t ? title(t) : "", dim: !t });
	}

	async press(action, s) {
		const t = targetThread(this.ctx, s);
		if (!t) return false;
		await this.ctx.client.settleThread(t.id);
		await action.showOk();
	}
}

export class NewThreadKey extends Base {
	manifestId = `${UUID}.new`;

	svg(s) {
		return iconKey({ glyph: "plus", label: s.label || "New thread", accent: C.brand, sub: s.prompt ? String(s.prompt) : null });
	}

	/** With a prompt: open it as a draft (T3 never sends it by itself). Without: T3's own New chat shortcut. */
	async press(action, s) {
		const prompt = String(s.prompt || "").trim();
		if (prompt) {
			const q = new URLSearchParams({ prompt });
			if (s.repo) q.set("repo", String(s.repo).trim());
			return this.ctx.openUrl(`t3code://new?${q}`);
		}
		return this.ctx.shortcut("chat.new");
	}
}

export class OpenKey extends Base {
	manifestId = `${UUID}.open`;

	svg(s) {
		return iconKey({ glyph: "t3", label: s.label || "T3 Code", accent: C.brand, sub: this.ctx.client.status === "online" ? null : "offline" });
	}

	press() {
		return this.ctx.openApp();
	}
}

// ------------------------------------------------------------------ T3 Code shortcuts

/** Commands from T3 Code's keybindings that make sense on a key. */
export const SHORTCUTS = {
	"thread.previous": ["Previous\nthread", "prev"],
	"thread.next": ["Next\nthread", "next"],
	"chat.new": ["New chat", "plus"],
	"commandPalette.toggle": ["Command\npalette", "palette"],
	"sidebar.toggle": ["Sidebar", "sidebar"],
	"terminal.toggle": ["Terminal", "terminal"],
	"diff.toggle": ["Diff", "diff"],
	"chat.find": ["Find", "search"],
	"filePicker.toggle": ["Files", "files"],
	"thread.pin": ["Pin thread", "pin"],
	"thread.settle": ["Settle", "check"],
	"navigation.back": ["Back", "back"],
	"navigation.forward": ["Forward", "forward"],
	"modelPicker.toggle": ["Model", "model"],
	"composer.mode": ["Mode", "keyboard"],
	"projectSearch.toggle": ["Search\nproject", "search"],
	"threadPanel.toggle": ["Thread\npanel", "sidebar"],
	"rightPanel.toggle": ["Right\npanel", "sidebar"],
	"thread.undo": ["Undo turn", "undo"],
};

export class ShortcutKey extends Base {
	manifestId = `${UUID}.shortcut`;

	svg(s) {
		const cmd = s.command || "thread.next";
		const [label, g] = SHORTCUTS[cmd] || [cmd, "keyboard"];
		return iconKey({ glyph: g, label: s.label ? String(s.label).replace(/\\n/g, "\n") : label, accent: C.brand, sub: this.ctx.keyFor(cmd) || null });
	}

	press(action, s) {
		return this.ctx.shortcut(s.command || "thread.next");
	}
}

// ------------------------------------------------------------------ dials

class DialBase extends SingletonAction {
	constructor(ctx) {
		super();
		this.ctx = ctx;
		this.visible = new Map(); // id -> {action, settings, img, sel, flash}
		ctx.client.on("change", () => this.redraw());
	}

	async onWillAppear(ev) {
		this.visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings || {}, img: null, sel: null, flash: null });
		await ev.action.setFeedbackLayout("layouts/canvas.json").catch(() => {});
		await this.draw(ev.action.id);
	}

	onWillDisappear(ev) {
		this.visible.delete(ev.action.id);
	}

	async onDidReceiveSettings(ev) {
		const e = this.visible.get(ev.action.id);
		if (!e) return;
		e.settings = ev.payload.settings || {};
		e.img = null;
		await this.draw(ev.action.id);
	}

	redraw() {
		for (const id of this.visible.keys()) this.draw(id).catch(() => {});
	}

	flash(id, text, ms = 900) {
		const e = this.visible.get(id);
		if (!e) return;
		e.flash = text;
		this.draw(id);
		clearTimeout(e.flashTimer);
		e.flashTimer = setTimeout(() => {
			e.flash = null;
			this.draw(id);
		}, ms);
	}

	async draw(id) {
		const e = this.visible.get(id);
		if (!e) return;
		const svg = this.svg(e);
		if (svg === e.img) return;
		e.img = svg;
		await e.action.setFeedback({ canvas: pngDataUrl(svg, 200) });
	}

	async guard(ev, fn) {
		try {
			const ok = await fn();
			if (ok === false) await ev.action.showAlert();
		} catch (e) {
			streamDeck.logger.warn(`${this.manifestId}: ${e.message}`);
			await ev.action.showAlert();
		}
	}
}

/** Threads dial: turn through the list, press (or touch) to open, long touch to mark done. */
export class ThreadsDial extends DialBase {
	manifestId = `${UUID}.dial.threads`;

	#list() {
		return inbox(this.ctx.client.topThreads());
	}

	#index(e, list) {
		const i = list.findIndex((x) => x.t.id === e.sel);
		return i >= 0 ? i : 0;
	}

	svg(e) {
		const cl = this.ctx.client;
		if (cl.status !== "online") return stripThread({ caption: "Threads", empty: true, title: "T3 offline" });
		const list = this.#list();
		if (!list.length) return stripThread({ caption: "Threads", empty: true, title: "all clear" });
		const i = this.#index(e, list);
		const x = list[i];
		return stripThread({ caption: "Threads", pos: `${i + 1}/${list.length}`, title: title(x.t), state: x.state, sub: [ago(stateSince(x.t, x.state)), cl.projectName(x.t)].filter(Boolean).join(" · "), flash: e.flash });
	}

	async onDialRotate(ev) {
		const e = this.visible.get(ev.action.id);
		const list = this.#list();
		if (!e || !list.length) return;
		const i = Math.max(0, Math.min(list.length - 1, this.#index(e, list) + ev.payload.ticks));
		e.sel = list[i].t.id;
		await this.draw(ev.action.id);
	}

	#selected(id) {
		const e = this.visible.get(id);
		const list = this.#list();
		return e && list.length ? list[this.#index(e, list)] : null;
	}

	async onDialDown(ev) {
		await this.guard(ev, () => {
			const x = this.#selected(ev.action.id);
			return x ? this.ctx.openThread(x.t.id) : this.ctx.openApp();
		});
	}

	async onTouchTap(ev) {
		await this.guard(ev, async () => {
			const x = this.#selected(ev.action.id);
			if (!x) return this.ctx.openApp();
			if (ev.payload.hold) {
				await this.ctx.client.settleThread(x.t.id);
				this.flash(ev.action.id, "Marked done");
				return;
			}
			return this.ctx.openThread(x.t.id);
		});
	}
}

const DEFAULT_REPLIES = ["Continue", "Yes, do it", "Run the tests and fix what fails", "Commit your work", "Explain what you changed"];

/** Reply dial: turn to pick a canned reply, press to send it to the current thread. */
export class ReplyDial extends DialBase {
	manifestId = `${UUID}.dial.reply`;

	#replies(e) {
		const lines = String(e.settings.replies || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		return lines.length ? lines : DEFAULT_REPLIES;
	}

	svg(e) {
		const r = this.#replies(e);
		const i = Math.min(r.length - 1, e.sel ?? 0);
		const t = targetThread(this.ctx, e.settings);
		return stripReply({ text: r[i], target: this.ctx.client.status === "online" ? (t ? title(t) : "") : "T3 offline", pos: `${i + 1}/${r.length}`, flash: e.flash });
	}

	async onDialRotate(ev) {
		const e = this.visible.get(ev.action.id);
		if (!e) return;
		const n = this.#replies(e).length;
		e.sel = ((((e.sel ?? 0) + ev.payload.ticks) % n) + n) % n;
		await this.draw(ev.action.id);
	}

	async onDialDown(ev) {
		await this.guard(ev, async () => {
			const e = this.visible.get(ev.action.id);
			const t = targetThread(this.ctx, e?.settings || {});
			if (!e || !t) {
				this.flash(ev.action.id, "No thread");
				return false;
			}
			const r = this.#replies(e);
			await this.ctx.client.sendMessage(t.id, r[Math.min(r.length - 1, e.sel ?? 0)]);
			this.flash(ev.action.id, "Sent");
		});
	}

	/** Touch: open the thread the reply would go to, to check it first. */
	async onTouchTap(ev) {
		await this.guard(ev, () => {
			const e = this.visible.get(ev.action.id);
			const t = targetThread(this.ctx, e?.settings || {});
			return t ? this.ctx.openThread(t.id) : this.ctx.openApp();
		});
	}
}

/** Sidebar dial: turn to step through T3 Code's thread list (its own next/previous shortcuts). */
export class NavDial extends DialBase {
	manifestId = `${UUID}.dial.nav`;

	svg(e) {
		const cl = this.ctx.client;
		if (cl.status !== "online") return stripThread({ caption: "Thread", empty: true, title: "T3 offline" });
		const t = currentThread(cl.topThreads());
		if (!t) return stripThread({ caption: "Thread", empty: true });
		const st = stateOf(t);
		return stripThread({ caption: "Thread", title: title(t), state: st, sub: cl.projectName(t), flash: e.flash });
	}

	async onDialRotate(ev) {
		const cmd = ev.payload.ticks > 0 ? "thread.next" : "thread.previous";
		const n = Math.min(5, Math.abs(ev.payload.ticks));
		for (let i = 0; i < n; i++) if ((await this.ctx.shortcut(cmd, { focus: false })) === false) return ev.action.showAlert();
	}

	/** Press: mark the current thread done. */
	async onDialDown(ev) {
		await this.guard(ev, async () => {
			const t = currentThread(this.ctx.client.topThreads());
			if (!t) return false;
			await this.ctx.client.settleThread(t.id);
			this.flash(ev.action.id, "Marked done");
		});
	}

	/** Touch: jump to the thread that needs you most. */
	async onTouchTap(ev) {
		await this.guard(ev, () => {
			const top = inbox(this.ctx.client.topThreads()).find((x) => x.state !== "idle");
			return top ? this.ctx.openThread(top.t.id) : false;
		});
	}
}

export const ACTIONS = [StatusKey, ThreadKey, ReplyKey, StopKey, SettleKey, NewThreadKey, OpenKey, ShortcutKey, ThreadsDial, ReplyDial, NavDial];
