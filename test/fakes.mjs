// Test doubles for the T3 Deck plugin:
//   FakeT3          a T3 Code server (HTTP + WebSocket, Effect RPC frames) with made-up threads
//   FakeStreamDeck  the Stream Deck app: runs the real bin/plugin.js and records what it sends
//   makeHome        a T3CODE_HOME folder with server-runtime.json and a stand-in `t3` CLI
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DEVICE = "TESTDEVICE01";
export const TOKEN = "test-token-123";
export const ENV_ID = "env-test-1";

/** Wait until fn() is truthy (polls every 25 ms). */
export async function until(fn, ms = 3000, what = "condition") {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await fn();
		if (v) return v;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ fake T3 Code server

export class FakeT3 extends EventEmitter {
	constructor({ threads = [], projects = [] } = {}) {
		super();
		this.threads = threads;
		this.projects = projects;
		this.commands = []; // dispatched commands
		this.clients = new Set();
		this.refused = 0;
	}

	async start() {
		this.http = http.createServer((req, res) => {
			if (req.url === "/.well-known/t3/environment") {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ environmentId: ENV_ID, label: "test" }));
			}
			res.writeHead(404).end();
		});
		this.wss = new WebSocketServer({ noServer: true });
		this.http.on("upgrade", (req, socket, head) => {
			const url = new URL(req.url, "http://x");
			if (url.pathname !== "/ws" || url.searchParams.get("orchestrationProtocol") !== "2") {
				socket.end("HTTP/1.1 426 Upgrade Required\r\n\r\n");
				return;
			}
			if (req.headers.authorization !== `Bearer ${TOKEN}`) {
				this.refused++;
				socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
				return;
			}
			this.wss.handleUpgrade(req, socket, head, (ws) => this.#client(ws));
		});
		await new Promise((r) => this.http.listen(0, "127.0.0.1", r));
		this.origin = `http://127.0.0.1:${this.http.address().port}`;
	}

	#client(ws) {
		const c = { ws, shellId: null };
		this.clients.add(c);
		ws.on("close", () => this.clients.delete(c));
		ws.on("message", (data) => {
			const m = JSON.parse(String(data));
			if (m._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
			if (m._tag !== "Request") return;
			if (m.tag === "orchestration.subscribeShell") {
				c.shellId = m.id;
				// Like the real server: the snapshot comes in more than one chunk.
				this.#chunk(c, [{ kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 7, threads: this.threads, archivedThreads: [], projects: this.projects } }]);
				this.#chunk(c, [{ kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 7, threads: [], archivedThreads: [], projects: this.projects } }, { kind: "synchronized" }]);
				this.emit("subscribed");
			} else if (m.tag === "orchestration.dispatchCommand") {
				this.commands.push(m.payload);
				this.emit("command", m.payload);
				ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Success", value: { sequence: this.commands.length } } }));
			} else {
				ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Failure", cause: { _tag: "Fail", error: { message: `unknown method ${m.tag}` } } } }));
			}
		});
	}

	#chunk(c, values) {
		c.ws.send(JSON.stringify({ _tag: "Chunk", requestId: c.shellId, values }));
	}

	/** Push a thread change to every subscriber. */
	update(thread) {
		const i = this.threads.findIndex((t) => t.id === thread.id);
		if (i >= 0) this.threads[i] = thread;
		else this.threads.push(thread);
		for (const c of this.clients) if (c.shellId) this.#chunk(c, [{ kind: "thread.updated", location: "active", thread }]);
	}

	get connected() {
		return [...this.clients].some((c) => c.shellId);
	}

	async stop() {
		for (const c of this.clients) c.ws.terminate();
		this.wss?.close();
		await new Promise((r) => this.http.close(r));
	}
}

/** A thread shell with the fields the plugin reads. */
export function thread(id, o = {}) {
	const now = Date.now();
	return {
		id,
		projectId: "p1",
		title: `Thread ${id}`,
		status: "idle",
		activityRunStatus: null,
		pendingRuntimeRequest: null,
		lastErrorClass: null,
		lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
		latestRunRequestedAt: new Date(now - 60000).toISOString(),
		latestRunStartedAt: new Date(now - 60000).toISOString(),
		latestRunCompletedAt: null,
		lastVisitedAt: new Date(now - 120000).toISOString(),
		settledAt: null,
		snoozedUntil: null,
		archivedAt: null,
		deletedAt: null,
		updatedAt: new Date(now - 60000).toISOString(),
		createdAt: new Date(now - 3600000).toISOString(),
		...o,
	};
}

// ------------------------------------------------------------------ fake T3 home

/** A T3CODE_HOME with userdata/server-runtime.json, environment-id and a stand-in t3.cmd. */
export function makeHome(origin) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3deck-home-"));
	fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });
	fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ pid: 1, host: "127.0.0.1", port: Number(new URL(origin).port), origin }));
	fs.writeFileSync(path.join(home, "userdata", "environment-id"), ENV_ID);
	fs.writeFileSync(path.join(home, "userdata", "keybindings.json"), JSON.stringify([{ key: "mod+shift+]", command: "thread.next" }, { key: "mod+alt+p", command: "commandPalette.toggle" }, { key: "mod+t", command: "terminal.new", when: "terminalFocus" }]));
	// The plugin asks this for a token when it has none. It also records that it was called.
	const issued = path.join(home, "issued.log");
	fs.writeFileSync(
		path.join(home, "bin", "t3.cmd"),
		`@echo off\r\necho %* >> "${issued}"\r\necho {"sessionId":"s1","token":"${TOKEN}","method":"bearer-access-token","expiresAt":"2099-01-01T00:00:00.000Z"}\r\n`,
	);
	return { home, issued };
}

// ------------------------------------------------------------------ fake Stream Deck

export class FakeStreamDeck extends EventEmitter {
	constructor({ pluginDir, globals = {}, env = {}, log = false }) {
		super();
		this.pluginDir = pluginDir;
		this.globals = globals;
		this.env = env;
		this.log = log;
		this.sent = [];
		this.settings = new Map();
		this.actions = new Map();
	}

	async start() {
		this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise((r) => this.wss.once("listening", r));
		const port = this.wss.address().port;
		const connected = new Promise((resolve) => {
			this.wss.on("connection", (ws) => {
				this.ws = ws;
				ws.on("message", (data) => this.#onMessage(JSON.parse(String(data)), resolve));
			});
		});
		const info = {
			application: { font: "Segoe UI", language: "en", platform: "windows", platformVersion: "10.0.26200", version: "7.4.2.22730" },
			plugin: { uuid: "com.coreloop.t3", version: "1.0.0.0" },
			devicePixelRatio: 2,
			colors: {},
			devices: [{ id: DEVICE, name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }],
		};
		this.proc = spawn(process.execPath, [path.join(this.pluginDir, "bin", "plugin.js"), "-port", String(port), "-pluginUUID", "com.coreloop.t3", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
			cwd: this.pluginDir,
			env: { ...process.env, ...this.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.stderr = "";
		this.proc.stderr.on("data", (d) => (this.stderr += d));
		this.proc.stdout.on("data", (d) => this.log && process.stdout.write(`[plugin] ${d}`));
		await connected;
		this.send({ event: "deviceDidConnect", device: DEVICE, deviceInfo: { name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 } });
	}

	#onMessage(msg, onRegister) {
		if (msg.event === "registerPlugin") return onRegister();
		this.sent.push(msg);
		if (this.log) console.log("<-", msg.event, msg.context ?? "", JSON.stringify(msg.payload ?? "").slice(0, 120));
		if (msg.event === "getGlobalSettings") this.send({ event: "didReceiveGlobalSettings", payload: { settings: this.globals } });
		if (msg.event === "setGlobalSettings") this.globals = msg.payload;
		if (msg.event === "setSettings") this.settings.set(msg.context, msg.payload);
		this.emit("message", msg);
	}

	send(obj) {
		this.ws.send(JSON.stringify(obj));
	}

	appear(action, { settings = {}, controller = "Keypad", column = 0, row = 0 } = {}) {
		const ctx = `ctx-${action}-${column}-${row}-${Math.random().toString(36).slice(2, 7)}`;
		const coordinates = { column, row };
		this.actions.set(ctx, { action, controller, coordinates });
		this.settings.set(ctx, settings);
		this.send({ action, event: "willAppear", context: ctx, device: DEVICE, payload: { controller, coordinates, isInMultiAction: false, settings, state: 0 } });
		return ctx;
	}

	disappear(ctx) {
		const a = this.actions.get(ctx);
		this.send({ action: a.action, event: "willDisappear", context: ctx, device: DEVICE, payload: { controller: a.controller, coordinates: a.coordinates, isInMultiAction: false, settings: this.settings.get(ctx), state: 0 } });
		this.actions.delete(ctx);
	}

	#ev(event, ctx, extra = {}) {
		const a = this.actions.get(ctx);
		this.send({ action: a.action, event, context: ctx, device: DEVICE, payload: { controller: a.controller, coordinates: a.coordinates, isInMultiAction: false, settings: this.settings.get(ctx) || {}, state: 0, ...extra } });
	}

	async tap(ctx, holdMs = 0) {
		this.#ev("keyDown", ctx);
		if (holdMs) await sleep(holdMs);
		this.#ev("keyUp", ctx);
	}
	rotate(ctx, ticks) {
		this.#ev("dialRotate", ctx, { ticks, pressed: false });
	}
	press(ctx) {
		this.#ev("dialDown", ctx);
		this.#ev("dialUp", ctx);
	}
	touch(ctx, hold = false) {
		this.#ev("touchTap", ctx, { tapPos: [100, 50], hold });
	}
	openInspector(ctx) {
		const a = this.actions.get(ctx);
		this.send({ action: a.action, event: "propertyInspectorDidAppear", context: ctx, device: DEVICE });
	}
	inspector(ctx, payload) {
		const a = this.actions.get(ctx);
		this.send({ action: a.action, event: "sendToPlugin", context: ctx, payload });
	}

	mark() {
		return this.sent.length;
	}
	since(mark, event, ctx) {
		return this.sent.slice(mark).filter((m) => (!event || m.event === event) && (!ctx || m.context === ctx));
	}
	last(event, ctx) {
		for (let i = this.sent.length - 1; i >= 0; i--) {
			const m = this.sent[i];
			if (m.event === event && (!ctx || m.context === ctx)) return m;
		}
		return null;
	}
	savePng(dataUrl, file) {
		fs.writeFileSync(file, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
	}

	async stop() {
		this.proc?.kill();
		this.wss?.close();
	}
}
