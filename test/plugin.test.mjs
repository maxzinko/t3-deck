// T3 Deck tests. Unit checks for the thread logic and the app rules, then the real
// plugin bundle against a fake Stream Deck app, a fake T3 Code server and a fake window
// watcher. Nothing here talks to the real T3 Code or the real Stream Deck.
//   node test/plugin.test.mjs        (build first: node tools/build.mjs)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DECKS, deckFor, profileName } from "../src/decks.js";
import { DEFAULT_RULES, Switcher, targetFor } from "../src/foreground.js";
import { unzipBuffer } from "../tools/zip.mjs";
import { counts, currentThread, inbox, stateOf } from "../src/t3.js";
import { wrap } from "../src/render.js";
import { ENV_ID, FakeStreamDeck, FakeT3, TOKEN, makeHome, sleep, thread, until } from "./fakes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "test", "out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
const fails = [];
function check(name, ok, detail = "") {
	if (ok) pass++;
	else fails.push(`${name}${detail ? `: ${detail}` : ""}`);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}

// ------------------------------------------------------------------ unit: thread logic
const now = Date.now();
const iso = (ago) => new Date(now - ago).toISOString();
const T = {
	A: thread("A", { title: "Which DB?", status: "running", pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: iso(5000), blocking: true }, activityRunStatus: "waiting" }),
	B: thread("B", { title: "Done unread", status: "completed", latestRunCompletedAt: iso(30000), lastVisitedAt: iso(60000) }),
	C: thread("C", { title: "Working", status: "running", activityRunStatus: "running" }),
	D: thread("D", { title: "Old settled", status: "idle", settledAt: iso(9999999) }),
	E: thread("E", { title: "Subagent", status: "running", activityRunStatus: "running", lineage: { parentThreadId: "C", relationshipToParent: "subagent", rootThreadId: "C" } }),
	F: thread("F", { title: "Current", status: "completed", latestRunCompletedAt: iso(20000), lastVisitedAt: iso(5000) }),
	G: thread("G", { title: "Broke", status: "failed", latestRunCompletedAt: iso(40000) }),
	H: thread("H", { title: "Limited", status: "failed", lastErrorClass: "usage_limit" }),
	Z: thread("Z", { title: "Settled, never opened", status: "completed", latestRunCompletedAt: iso(900000), settledAt: iso(800000), lastVisitedAt: null }),
	Y: thread("Y", { title: "New work after settle", status: "completed", latestRunRequestedAt: iso(70000), latestRunCompletedAt: iso(10000), settledAt: iso(800000), lastVisitedAt: iso(900000) }),
	S: thread("S", { title: "Snoozed done", status: "completed", latestRunCompletedAt: iso(30000), lastVisitedAt: iso(60000), snoozedUntil: new Date(now + 3600000).toISOString() }),
};
check("stateOf: question = input", stateOf(T.A) === "input");
check("stateOf: finished after last visit = done", stateOf(T.B) === "done");
check("stateOf: running = working", stateOf(T.C) === "working");
check("stateOf: finished and read = idle", stateOf(T.F) === "idle");
check("stateOf: failed / usage limit", stateOf(T.G) === "failed" && stateOf(T.H) === "limited");
const list = inbox(Object.values(T), now);
const order = list.map((x) => x.t.id).join("");
check("inbox: urgent first; settled only with news; no subagent/snoozed", order === "AGHBYCF", order);
const c = counts(list);
check("counts", c.input === 1 && c.failed === 2 && c.done === 2 && c.working === 1, JSON.stringify(c));
check("current thread = last visited, never a subagent", currentThread(Object.values(T))?.id === "F");
check("wrap: words, ellipsis", JSON.stringify(wrap("Stream Deck + Blender pack (build) and more words here", 12, 3)) === JSON.stringify(["Stream Deck", "+ Blender", "pack (build…"]), JSON.stringify(wrap("Stream Deck + Blender pack (build) and more words here", 12, 3)));

// ------------------------------------------------------------------ unit: app rules
const w = (exe, cls = "") => ({ exe, cls });
check("rules: Chrome -> Desktop, last page", JSON.stringify(targetFor(w("chrome.exe"))) === JSON.stringify({ profile: "Desktop", page: null }));
check("rules: T3 Code -> Code", targetFor(w("T3 Code (Nightly).exe"))?.profile === "Code");
check("rules: any other program -> Desktop, last page", JSON.stringify(targetFor(w("blender.exe"))) === JSON.stringify({ profile: "Desktop", page: null }));
check("rules: ignore leaves the deck alone", targetFor(w("blender.exe"), "blender.exe = ignore\n* = Desktop") === null);
check("rules: Stream Deck app and Alt+Tab pass by", targetFor(w("StreamDeck.exe")) === "transient" && targetFor(w("explorer.exe", "XamlExplorerHostIslandWindow")) === "transient");
check("rules: custom", JSON.stringify(targetFor(w("Code.exe"), "code.exe = Code 2\n* = ignore")) === JSON.stringify({ profile: "Code", page: 2 }) && targetFor(w("x.exe"), "code.exe = Code 2\n* = ignore") === null);
check("rules: comments and blank rules fall back", targetFor(w("chrome.exe"), "# nothing") === null && targetFor(w("chrome.exe"), "")?.profile === "Desktop");

{
	const calls = [];
	const sw = new Switcher({ switchTo: (d, n, p) => calls.push(`${n}:${p}`), devices: () => [{ id: "d1", type: 7 }] });
	// A rule with a page number, to test pages too.
	sw.configure({ rules: ["blender.exe = ignore", "T3 Code*.exe = Code", "chrome.exe = Desktop 1", "* = Desktop"].join("\n") });
	const step = async (exe) => {
		sw.onWindow(w(exe));
		await sleep(300);
	};
	await step("chrome.exe");
	await step("StreamDeck.exe");
	await step("chrome.exe");
	check("switcher: Chrome once; Stream Deck app and the same app again do nothing", calls.join() === "T3 Deck Desktop:0", calls.join());
	await step("blender.exe");
	await step("chrome.exe");
	check("switcher: back from Blender switches again", calls.length === 2, calls.join());
	sw.appeared("d1", "k1", "Desktop", 3);
	await step("notepad.exe");
	check("switcher: already on Desktop (page 3), another program keeps it", calls.length === 2, calls.join());
	await step("chrome.exe");
	check("switcher: Chrome asks for page 1", calls.at(-1) === "T3 Deck Desktop:0", calls.join());
	sw.disappeared("d1", "k1");
	sw.appeared("d1", "k2", "Code", 2);
	sw.disappeared("d1", "k2");
	await step("T3 Code (Nightly).exe");
	check("switcher: T3 Code opens Code on the page used last", calls.at(-1) === "T3 Deck Code:1", calls.join());
	sw.onWindow(w("explorer.exe"));
	sw.onWindow(w("chrome.exe"));
	await sleep(300);
	check("switcher: quick passes collapse into one switch", calls.at(-1) === "T3 Deck Desktop:0" && calls.length === 5, calls.join());
	{
		const late = [];
		let devs = [];
		const sw2 = new Switcher({ switchTo: (d, n) => late.push(n), devices: () => devs });
		sw2.onWindow(w("chrome.exe"));
		await sleep(300);
		devs = [{ id: "d1", type: 7 }];
		sw2.refresh(w("chrome.exe"));
		await sleep(300);
		check("switcher: a device that connects late still gets the profile", late.join() === "T3 Deck Desktop", late.join());
	}
	sw.configure({ enabled: false });
	await step("notepad.exe");
	check("switcher: off means off", calls.length === 5);
}
{
	// Each model gets its own profiles; a model without T3 Deck profiles is never switched.
	const calls = [];
	const sw = new Switcher({ switchTo: (d, n, p) => calls.push(`${d}=${n}:${p}`), devices: () => [{ id: "plus", type: 7 }, { id: "mk2", type: 0 }, { id: "xl", type: 2 }, { id: "mini", type: 1 }] });
	sw.onWindow(w("T3 Code.exe"));
	await sleep(300);
	check("switcher: each deck model gets its own profile, the Mini none", calls.join() === "plus=T3 Deck Code:0,mk2=T3 Deck Code MK2:0,xl=T3 Deck Code XL:0", calls.join());
}

// ------------------------------------------------------------------ profiles (the built files)
{
	const sd = path.join(ROOT, "com.coreloop.t3.sdPlugin");
	const manifest = JSON.parse(fs.readFileSync(path.join(sd, "manifest.json"), "utf8"));
	const missing = [];
	const wrong = [];
	for (const p of manifest.Profiles) {
		const f = path.join(sd, `${p.Name}.streamDeckProfile`);
		if (!fs.existsSync(f)) {
			missing.push(p.Name);
			continue;
		}
		const deck = deckFor(p.DeviceType);
		const entries = unzipBuffer(fs.readFileSync(f));
		const top = JSON.parse(entries.find((e) => e.name.split("/").length === 2).data);
		if (top.Name !== p.Name || top.Device.Model !== deck.model) wrong.push(`${p.Name}: ${top.Name} ${top.Device.Model}`);
		for (const e of entries.filter((x) => x.name.split("/").length === 4)) {
			for (const c of JSON.parse(e.data).Controllers) {
				for (const [pos, a] of Object.entries(c.Actions)) {
					const [col, row] = pos.split(",").map(Number);
					const off = c.Type === "Keypad" ? col >= deck.cols || row >= deck.rows : col >= deck.dials || row > 0;
					if (off) wrong.push(`${p.Name} ${c.Type} ${pos} is off the deck`);
					if (!a.Settings?.deckProfile || !a.Settings?.deckPage) wrong.push(`${p.Name} ${pos}: no deckProfile/deckPage`);
					if (!manifest.Actions.some((x) => x.UUID === a.UUID)) wrong.push(`${p.Name} ${pos}: unknown action ${a.UUID}`);
				}
			}
		}
	}
	check("profiles: a Desktop and a Code profile per deck model", manifest.Profiles.length === DECKS.length * 2 && DECKS.every((d) => manifest.Profiles.some((p) => p.Name === profileName("Code", d.type) && p.DeviceType === d.type)), manifest.Profiles.map((p) => p.Name).join());
	check("profiles: every file is there", !missing.length, missing.join());
	check("profiles: names, models, keys on the deck, tagged with their page", !wrong.length, wrong.slice(0, 4).join("; "));
}

// ------------------------------------------------------------------ the plugin, end to end
const pluginDir = path.join(ROOT, "com.coreloop.t3.sdPlugin");
if (!fs.existsSync(path.join(pluginDir, "bin", "plugin.js"))) throw new Error("build first: node tools/build.mjs");

const t3 = new FakeT3({ threads: Object.values(T).map((x) => structuredClone(x)), projects: [{ id: "p1", title: "proj" }] });
await t3.start();
const { home, issued } = makeHome(t3.origin);
const files = { windows: path.join(OUT, "windows.jsonl"), keys: path.join(OUT, "keys.log"), opened: path.join(OUT, "opened.log") };
for (const f of Object.values(files)) fs.writeFileSync(f, "");
const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
// What the helper was asked to do: key presses ("keys ...") and focus requests ("focus ...").
const keys = () => read(files.keys).filter((l) => l.startsWith("keys "));
const focused = () => read(files.keys).filter((l) => l.startsWith("focus "));
const win = (exe, cls = "Chrome_WidgetWin_1") => fs.appendFileSync(files.windows, JSON.stringify({ pid: 1, exe, path: `C:\\x\\${exe}`, cls, title: exe, min: false }) + "\n");

const deck = new FakeStreamDeck({
	pluginDir,
	globals: {},
	log: !!process.env.VERBOSE,
	env: { T3CODE_HOME: home, T3DECK_FGWATCH: path.join(ROOT, "test", "fake-fgwatch.mjs"), T3DECK_WINDOWS: files.windows, T3DECK_KEYS_LOG: files.keys, T3DECK_OPEN_LOG: files.opened },
});
const cmdAfter = async (n, what) => until(() => t3.commands[n], 3000, what);
const link = (id) => `t3code://threads/${ENV_ID}/${encodeURIComponent(id)}`;

try {
	await deck.start();
	await until(() => t3.connected, 8000, "plugin to connect (after getting a token)");
	check("no token: asks T3's CLI for one with read + operate scopes", /auth session issue .*--scope orchestration:read --scope orchestration:operate --ttl 30d --label "Stream Deck" --json/.test(fs.readFileSync(issued, "utf8")), fs.readFileSync(issued, "utf8"));
	check("token kept in global settings", deck.globals.token === TOKEN && deck.globals.tokenExpires === "2099-01-01T00:00:00.000Z");

	// Profile switching by the program in front (no T3 Deck keys on screen yet).
	let m = deck.mark();
	win("chrome.exe");
	await until(() => deck.since(m, "switchToProfile").length, 2000, "switch for Chrome");
	const sw = deck.since(m, "switchToProfile")[0];
	check("Chrome in front: switches to T3 Deck Desktop", sw.payload.profile === "T3 Deck Desktop" && sw.payload.page === 0 && sw.device === "TESTDEVICE01", JSON.stringify(sw.payload));
	m = deck.mark();
	// The Desktop profile comes up: its keys say where they are.
	const desk = deck.appear("com.coreloop.t3.status", { settings: { deckProfile: "Desktop", deckPage: 1 } });
	await sleep(100);
	win("notepad.exe", "Notepad");
	await sleep(400);
	check("another program while Desktop shows: the deck stays", deck.since(m, "switchToProfile").length === 0);
	deck.disappear(desk);
	win("T3 Code (Nightly).exe");
	await until(() => deck.since(m, "switchToProfile").length, 2000, "switch for T3");
	check("T3 Code in front: switches to T3 Deck Code", deck.since(m, "switchToProfile")[0].payload.profile === "T3 Deck Code");

	// Keys (as if the Code profile is on screen).
	const tag = { deckProfile: "Code", deckPage: 1 };
	m = deck.mark();
	const status = deck.appear("com.coreloop.t3.status", { settings: tag });
	const slot3 = deck.appear("com.coreloop.t3.thread", { settings: { ...tag, slot: 4 }, column: 1 });
	const reply = deck.appear("com.coreloop.t3.reply", { settings: { ...tag, text: "Continue" }, column: 2 });
	const replyTop = deck.appear("com.coreloop.t3.reply", { settings: { ...tag, text: "Go on", target: "top" }, column: 3 });
	const stop = deck.appear("com.coreloop.t3.stop", { settings: tag, row: 1 });
	const settle = deck.appear("com.coreloop.t3.settle", { settings: tag, row: 1, column: 1 });
	const sc = deck.appear("com.coreloop.t3.shortcut", { settings: { ...tag, command: "thread.next" }, row: 1, column: 2 });
	const pal = deck.appear("com.coreloop.t3.shortcut", { settings: { ...tag, command: "commandPalette.toggle" }, row: 1, column: 3 });
	const dThreads = deck.appear("com.coreloop.t3.dial.threads", { settings: tag, controller: "Encoder" });
	const dReply = deck.appear("com.coreloop.t3.dial.reply", { settings: tag, controller: "Encoder", column: 1 });
	const dNav = deck.appear("com.coreloop.t3.dial.nav", { settings: tag, controller: "Encoder", column: 2 });
	await until(() => deck.since(m, "setImage").length >= 8 && deck.since(m, "setFeedback").length >= 3, 3000, "images");
	check("keys draw themselves", [status, slot3, reply, stop, settle, sc].every((k) => deck.last("setImage", k)?.payload?.image?.startsWith("data:image/png")));
	check("dials draw their touch strip", [dThreads, dReply, dNav].every((k) => deck.last("setFeedback", k)?.payload?.canvas?.startsWith("data:image/png")));
	deck.savePng(deck.last("setImage", status).payload.image, path.join(OUT, "status.png"));
	deck.savePng(deck.last("setImage", slot3).payload.image, path.join(OUT, "slot4.png"));
	deck.savePng(deck.last("setFeedback", dThreads).payload.canvas, path.join(OUT, "dial-threads.png"));

	// Status key: open the thread that needs you most.
	await deck.tap(status);
	await until(() => read(files.opened).length, 2000, "open");
	check("status press opens the thread that needs you", read(files.opened).at(-1) === link("A"), read(files.opened).at(-1));
	await until(() => focused().length, 2000, "focus").catch(() => {});
	check("…and has the helper bring T3 Code to the front", focused().at(-1) === "focus T3 Code", focused().join());

	// Slot 4 = B (A, G, H, B...). Press opens it; holding marks it done.
	await deck.tap(slot3);
	await until(() => read(files.opened).length >= 2, 2000, "open slot");
	check("thread key opens its thread", read(files.opened).at(-1) === link("B"), read(files.opened).at(-1));
	let n = t3.commands.length;
	await deck.tap(slot3, 700);
	let cmd = await cmdAfter(n, "settle from hold");
	check("holding a thread key settles it", cmd.type === "thread.settle" && cmd.threadId === "B" && /^[0-9a-f-]{36}$/.test(cmd.commandId), JSON.stringify(cmd));

	// Quick reply goes to the thread you looked at last (F), started right away.
	n = t3.commands.length;
	await deck.tap(reply);
	cmd = await cmdAfter(n, "reply");
	check("reply: message to the current thread", cmd.type === "message.dispatch" && cmd.threadId === "F" && cmd.text === "Continue" && cmd.createdBy === "user" && Array.isArray(cmd.attachments), JSON.stringify(cmd));
	check("reply: idle thread starts at once", cmd.dispatchMode?.type === "start_immediately" && cmd.deliveryIntent === "auto" && cmd.messageId && cmd.messageId !== cmd.commandId);
	n = t3.commands.length;
	await deck.tap(replyTop);
	cmd = await cmdAfter(n, "reply top");
	check("reply with target 'top' goes to the thread that needs you", cmd.threadId === "A" && cmd.text === "Go on");

	// F starts working (pushed by the server): replies queue, Stop lights up and works.
	m = deck.mark();
	t3.update({ ...T.F, status: "running", activityRunStatus: "running", latestRunCompletedAt: null });
	await until(() => deck.since(m, "setImage", stop).length, 2000, "stop key redraw");
	check("server push redraws the keys", true);
	n = t3.commands.length;
	await deck.tap(reply);
	cmd = await cmdAfter(n, "queued reply");
	check("reply to a working thread is queued for its next turn", cmd.dispatchMode?.type === "queue_after_active" && !cmd.deliveryIntent, JSON.stringify(cmd.dispatchMode));
	n = t3.commands.length;
	await deck.tap(stop);
	cmd = await cmdAfter(n, "stop");
	check("stop: stops the working current thread", cmd.type === "thread.stop" && cmd.threadId === "F");
	n = t3.commands.length;
	await deck.tap(settle);
	cmd = await cmdAfter(n, "settle");
	check("mark done: settles the current thread", cmd.type === "thread.settle" && cmd.threadId === "F");

	// Stop on an idle thread does nothing and shows an alert.
	t3.update({ ...T.F, status: "completed", activityRunStatus: null });
	await sleep(200);
	m = deck.mark();
	n = t3.commands.length;
	await deck.tap(stop);
	await until(() => deck.since(m, "showAlert", stop).length, 2000, "alert");
	check("stop on an idle thread: alert, no command", t3.commands.length === n);

	// Shortcuts: T3 Code is in front (last window), so keys go straight to it.
	await deck.tap(sc);
	await until(() => keys().length, 2000, "keys");
	check("shortcut uses your keybinding (mod+shift+] -> ctrl+shift+])", keys().at(-1) === "keys ctrl+shift+]", keys().at(-1));
	await deck.tap(pal);
	await until(() => keys().length >= 2, 2000, "keys 2");
	check("shortcut: your own binding wins over the default", keys().at(-1) === "keys ctrl+alt+p", keys().at(-1));

	// With Chrome in front a shortcut brings T3 Code up first, then presses the keys.
	win("chrome.exe");
	await sleep(300);
	const opened = read(files.opened).length;
	const keysBefore = keys().length;
	await deck.tap(sc);
	await until(() => read(files.opened).length > opened, 2000, "focus T3");
	check("shortcut from Chrome: opens T3 Code first", read(files.opened).at(-1) === link("F"));
	check("…and sends nothing while Chrome is still in front", keys().length === keysBefore);
	win("T3 Code (Nightly).exe");
	await until(() => keys().length > keysBefore, 3000, "keys after focus");
	check("…then presses the keys once T3 Code is in front", keys().at(-1) === "keys ctrl+shift+]");

	// Thread navigator dial: only while T3 Code is in front.
	deck.rotate(dNav, 1);
	await until(() => keys().length > keysBefore + 1, 2000, "nav keys");
	check("navigator dial: turning steps T3 Code's thread list", keys().at(-1) === "keys ctrl+shift+]");
	win("chrome.exe");
	await sleep(350);
	m = deck.mark();
	const k2 = keys().length;
	deck.rotate(dNav, -1);
	await until(() => deck.since(m, "showAlert", dNav).length, 2000, "nav alert");
	check("navigator dial never sends keys to another program", keys().length === k2);

	// Threads dial: turn, press opens, long touch settles.
	deck.rotate(dThreads, 1);
	await sleep(150);
	deck.press(dThreads);
	await until(() => read(files.opened).at(-1) === link("G"), 2000, "dial open G");
	check("threads dial: turn + press opens the second thread", true);
	n = t3.commands.length;
	deck.touch(dThreads, true);
	cmd = await cmdAfter(n, "dial settle");
	check("threads dial: long touch marks it done", cmd.type === "thread.settle" && cmd.threadId === "G");

	// Reply dial: pick the third reply and send it.
	deck.rotate(dReply, 2);
	await sleep(150);
	n = t3.commands.length;
	deck.press(dReply);
	cmd = await cmdAfter(n, "dial reply");
	check("reply dial: sends the picked reply", cmd.type === "message.dispatch" && cmd.text === "Run the tests and fix what fails" && cmd.threadId === "F", cmd.text);
	deck.savePng(deck.last("setFeedback", dReply).payload.canvas, path.join(OUT, "dial-reply.png"));

	// Status key settings page: info, rules, switching off.
	m = deck.mark();
	deck.openInspector(status);
	await until(() => deck.since(m, "sendToPropertyInspector").length, 2000, "PI info");
	const info = deck.since(m, "sendToPropertyInspector")[0].payload;
	check("settings page gets status, never the token", info.status === "online" && info.hasToken === true && !JSON.stringify(info).includes(TOKEN) && info.rules === DEFAULT_RULES, JSON.stringify(info).slice(0, 200));
	const chk = Object.fromEntries((info.checks || []).map((c) => [c.id, c]));
	check("setup checklist: T3 found and running, CLI, signed in, watcher, the deck", ["home", "running", "cli", "access", "watcher", "deck-TESTDEVICE01"].every((id) => chk[id]?.ok), JSON.stringify(info.checks?.filter((c) => !c.ok)));
	check("setup checklist: every step says how to fix it", info.checks.every((c) => c.label && c.fix));
	deck.inspector(status, { event: "save", auto: false, rules: DEFAULT_RULES });
	await sleep(200);
	m = deck.mark();
	win("notepad.exe");
	await sleep(500);
	check("switching off in settings stops profile switching", deck.since(m, "switchToProfile").length === 0 && deck.globals.auto === false && deck.globals.token === TOKEN);

	// T3 Code updates: the server goes away, then comes back on another port.
	const online = deck.last("setImage", status).payload.image;
	const issuedBefore = fs.readFileSync(issued, "utf8");
	await t3.stop();
	await until(() => deck.last("setImage", status).payload.image !== online, 5000, "offline image");
	check("T3 closed: the status key says offline", true);
	deck.savePng(deck.last("setImage", status).payload.image, path.join(OUT, "status-offline.png"));
	await sleep(1500);
	await t3.start();
	fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: 2, host: "127.0.0.1", port: Number(new URL(t3.origin).port), origin: t3.origin }));
	await until(() => t3.connected, 12000, "reconnect after restart").catch(() => {});
	check("T3 back on a new port: reconnects by itself", t3.connected);
	check("…with the same token (no new one asked for)", fs.readFileSync(issued, "utf8") === issuedBefore);
	await until(() => deck.last("setImage", status).payload.image === online, 3000, "online image").catch(() => {});
	check("…and the status key is back to what it showed", deck.last("setImage", status).payload.image === online);
	n = t3.commands.length;
	await deck.tap(settle);
	cmd = await cmdAfter(n, "command after restart").catch(() => null);
	check("…and commands work again", cmd?.type === "thread.settle");
} finally {
	await deck.stop();
}

// A stored token that T3 refuses gets replaced.
{
	const deck2 = new FakeStreamDeck({
		pluginDir,
		globals: { token: "revoked-token" },
		env: { T3CODE_HOME: home, T3DECK_FGWATCH: path.join(ROOT, "test", "fake-fgwatch.mjs"), T3DECK_WINDOWS: files.windows, T3DECK_OPEN_LOG: files.opened },
	});
	const refusedBefore = t3.refused;
	try {
		await deck2.start();
		await until(() => t3.connected && deck2.globals.token === TOKEN, 15000, "new token after refusal");
		check("refused token: gets a new one and connects", t3.refused - refusedBefore >= 2);
	} catch (e) {
		check("refused token: gets a new one and connects", false, e.message);
	} finally {
		await deck2.stop();
	}
}

await t3.stop();
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
	for (const f of fails) console.log(`  FAIL ${f}`);
	process.exit(1);
}
process.exit(0);
