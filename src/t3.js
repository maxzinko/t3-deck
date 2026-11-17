// Talks to the local T3 Code server the way its own app does: a WebSocket at
// /ws?orchestrationProtocol=2 carrying Effect RPC JSON frames.
//   - orchestration.subscribeShell pushes every thread's status (no polling).
//   - orchestration.dispatchCommand sends commands (message, stop, visit, settle).
// The address comes from ~/.t3/userdata/server-runtime.json, so a port change is fine.
// The bearer token is a normal T3 session issued by T3's own CLI
// (`t3 auth session issue`), labelled "Stream Deck", revocable in T3's
// Settings > Sharing & access. The token is never logged.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const T3_HOME = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
const USERDATA = () => path.join(T3_HOME, "userdata");

export function readRuntime() {
	try {
		const rt = JSON.parse(fs.readFileSync(path.join(USERDATA(), "server-runtime.json"), "utf8"));
		return rt?.origin ? rt : null;
	} catch {
		return null;
	}
}

export function readEnvironmentId() {
	try {
		return fs.readFileSync(path.join(USERDATA(), "environment-id"), "utf8").trim();
	} catch {
		return "";
	}
}

/** T3's command line, which T3 Code installs next to its data. */
export const T3_CLI = path.join(T3_HOME, "bin", process.platform === "win32" ? "t3.cmd" : "t3");

/** Issue a new token with T3's CLI. Resolves {token, expiresAt}. */
export function issueToken({ ttl = "30d", label = "Stream Deck", cli = T3_CLI } = {}) {
	return new Promise((resolve, reject) => {
		const args = ["auth", "session", "issue", "--scope", "orchestration:read", "--scope", "orchestration:operate", "--ttl", ttl, "--label", label, "--json"];
		// A .cmd needs the shell on Windows; every argument here is a fixed word.
		const opts = { timeout: 30000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 1 << 20 };
		execFile(process.platform === "win32" ? `"${cli}"` : cli, args.map((a) => (a.includes(" ") ? `"${a}"` : a)), opts, (err, stdout) => {
			if (err) return reject(new Error(`t3 auth session issue failed: ${String(err.message).split("\n")[0]}`));
			try {
				const j = JSON.parse(String(stdout).slice(String(stdout).indexOf("{")));
				const token = j.token || j.accessToken || j.bearerToken || j.session?.token;
				if (!token) return reject(new Error("t3 auth session issue printed no token"));
				resolve({ token, expiresAt: j.expiresAt || j.session?.expiresAt || null });
			} catch (e) {
				reject(new Error(`t3 auth session issue: unreadable output (${e.message})`));
			}
		});
	});
}

const SUBAGENT = (t) => t?.lineage?.relationshipToParent === "subagent";

export class T3Client extends EventEmitter {
	constructor({ log, getToken, onNeedToken }) {
		super();
		this.setMaxListeners(100);
		this.log = log;
		this.getToken = getToken; // () => string
		this.onNeedToken = onNeedToken; // async (reason) => void, should store a new token
		this.threads = new Map();
		this.projects = new Map();
		this.status = "offline"; // offline | connecting | online | auth
		this.error = "";
		this.origin = "";
		this.environmentId = "";
		this.ws = null;
		this.nextId = 1;
		this.pending = new Map(); // request id -> {resolve, reject, timer}
		this.shellId = null;
		this.snapshotSeq = null;
		this.failures = 0;
		this.stopped = true;
		this.changeTimer = null;
	}

	start() {
		this.stopped = false;
		this.#connect();
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.retryTimer);
		clearInterval(this.pingTimer);
		try {
			this.ws?.close();
		} catch {}
	}

	/** Drop the connection and connect again (after a token change). */
	reconnect() {
		this.failures = 0;
		try {
			this.ws?.close();
		} catch {}
		if (!this.ws) this.#schedule(50);
	}

	#setStatus(s, err = "") {
		if (s === this.status && err === this.error) return;
		this.status = s;
		this.error = err;
		this.emit("status", s, err);
		this.#changed();
	}

	#changed() {
		if (this.changeTimer) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = null;
			this.emit("change");
		}, 80);
	}

	#schedule(ms) {
		clearTimeout(this.retryTimer);
		if (!this.stopped) this.retryTimer = setTimeout(() => this.#connect(), ms);
	}

	async #connect() {
		if (this.stopped || this.ws) return;
		const rt = readRuntime();
		if (!rt) {
			this.#setStatus("offline", "T3 Code is not running");
			return this.#schedule(5000);
		}
		this.origin = rt.origin;
		this.environmentId = this.environmentId || readEnvironmentId();
		let token = this.getToken();
		if (!token) {
			this.#setStatus("auth", "getting a token");
			try {
				await this.onNeedToken("no token");
			} catch (e) {
				this.#setStatus("auth", e.message);
				return this.#schedule(60000);
			}
			token = this.getToken();
			if (!token) return this.#schedule(60000);
		}
		this.#setStatus("connecting");
		let opened = false;
		let ws;
		try {
			ws = new WebSocket(rt.origin.replace(/^http/, "ws") + "/ws?orchestrationProtocol=2", { headers: { Authorization: `Bearer ${token}` } });
		} catch (e) {
			this.#setStatus("offline", e.message);
			return this.#schedule(5000);
		}
		this.ws = ws;
		ws.onopen = () => {
			opened = true;
			this.failures = 0;
			this.lastPong = Date.now();
			this.#subscribe();
			clearInterval(this.pingTimer);
			this.pingTimer = setInterval(() => this.#ping(), 15000);
		};
		ws.onmessage = (ev) => this.#onFrame(ev.data);
		ws.onerror = () => {};
		ws.onclose = async () => {
			clearInterval(this.pingTimer);
			if (this.ws === ws) this.ws = null;
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(new Error("connection closed"));
			}
			this.pending.clear();
			this.shellId = null;
			if (this.stopped) return;
			if (opened) {
				this.#setStatus("connecting", "reconnecting");
				return this.#schedule(1000);
			}
			// The upgrade failed. If the server is up, the token is the likely cause.
			this.failures++;
			const up = await this.#serverUp(rt.origin);
			if (!up) {
				this.#setStatus("offline", "T3 Code is not running");
				return this.#schedule(5000);
			}
			if (this.failures >= 2) {
				this.#setStatus("auth", "token refused");
				this.failures = 0;
				try {
					await this.onNeedToken("token refused");
					return this.#schedule(500);
				} catch (e) {
					this.#setStatus("auth", e.message);
					return this.#schedule(60000);
				}
			}
			this.#schedule(1500);
		};
	}

	async #serverUp(origin) {
		try {
			const r = await fetch(origin + "/.well-known/t3/environment", { signal: AbortSignal.timeout(3000) });
			if (r.ok) {
				const j = await r.json().catch(() => ({}));
				if (j?.environmentId) this.environmentId = j.environmentId;
			}
			return r.ok;
		} catch {
			return false;
		}
	}

	#send(frame) {
		if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame));
	}

	#ping() {
		if (Date.now() - this.lastPong > 45000) {
			this.log?.warn("T3: no reply for 45 s, reconnecting");
			try {
				this.ws?.close();
			} catch {}
			return;
		}
		this.#send({ _tag: "Ping" });
	}

	#subscribe() {
		this.shellId = String(this.nextId++);
		this.snapshotSeq = null;
		this.#send({ _tag: "Request", id: this.shellId, tag: "orchestration.subscribeShell", payload: {}, headers: [] });
	}

	#onFrame(data) {
		this.lastPong = Date.now();
		let m;
		try {
			m = JSON.parse(String(data));
		} catch {
			return;
		}
		switch (m._tag) {
			case "Chunk":
				this.#send({ _tag: "Ack", requestId: m.requestId });
				if (m.requestId === this.shellId) for (const v of m.values || []) this.#apply(v);
				break;
			case "Exit": {
				const p = this.pending.get(m.requestId);
				if (p) {
					this.pending.delete(m.requestId);
					clearTimeout(p.timer);
					if (m.exit?._tag === "Success") p.resolve(m.exit.value);
					else p.reject(new Error(describeFailure(m.exit)));
				} else if (m.requestId === this.shellId) {
					// The stream ended (server restart or a schema change): subscribe again.
					this.log?.warn(`T3: shell stream ended (${describeFailure(m.exit)})`);
					setTimeout(() => this.ws && this.#subscribe(), 1000);
				}
				break;
			}
			case "Defect":
				this.log?.warn(`T3: server defect ${JSON.stringify(m.defect).slice(0, 200)}`);
				break;
			case "Ping":
				this.#send({ _tag: "Pong" });
				break;
		}
	}

	#apply(v) {
		switch (v?.kind) {
			case "snapshot": {
				const s = v.snapshot || {};
				if (s.snapshotSequence !== this.snapshotSeq) {
					this.snapshotSeq = s.snapshotSequence;
					this.threads.clear();
					this.projects.clear();
				}
				for (const t of s.threads || []) if (!t.deletedAt && !t.archivedAt) this.threads.set(t.id, t);
				for (const t of s.archivedThreads || []) this.threads.delete(t.id);
				for (const p of s.projects || []) this.projects.set(p.id, p);
				if (this.status !== "online") this.#setStatus("online");
				break;
			}
			case "synchronized":
				if (this.status !== "online") this.#setStatus("online");
				break;
			case "thread.updated": {
				const t = v.thread;
				if (!t?.id) break;
				if (v.location === "archive" || t.archivedAt || t.deletedAt) this.threads.delete(t.id);
				else this.threads.set(t.id, t);
				break;
			}
			case "thread.removed":
			case "thread.deleted":
				this.threads.delete(v.threadId || v.thread?.id);
				break;
			case "project.updated":
				if (v.project?.id) this.projects.set(v.project.id, v.project);
				break;
			case "project.removed":
				this.projects.delete(v.projectId || v.project?.id);
				break;
			default:
				return;
		}
		this.#changed();
	}

	/** Send one RPC request and wait for its Exit. */
	request(tag, payload, timeoutMs = 15000) {
		return new Promise((resolve, reject) => {
			if (this.ws?.readyState !== 1) return reject(new Error("T3 Code is not connected"));
			const id = String(this.nextId++);
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${tag} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.#send({ _tag: "Request", id, tag, payload, headers: [] });
		});
	}

	dispatch(command) {
		return this.request("orchestration.dispatchCommand", { commandId: crypto.randomUUID(), ...command });
	}

	// ---------------------------------------------------------------- commands

	/** Send a chat message. A busy thread gets it queued as its next turn, like `t3 thread send`. */
	sendMessage(threadId, text) {
		const t = this.threads.get(threadId);
		const busy = t && isWorking(t);
		return this.dispatch({
			type: "message.dispatch",
			createdBy: "user",
			creationSource: "web",
			threadId,
			messageId: crypto.randomUUID(),
			text,
			attachments: [],
			...(busy ? {} : { deliveryIntent: "auto" }),
			dispatchMode: { type: busy ? "queue_after_active" : "start_immediately" },
		});
	}

	stopThread(threadId) {
		return this.dispatch({ type: "thread.stop", threadId });
	}

	settleThread(threadId) {
		return this.dispatch({ type: "thread.settle", threadId });
	}

	visitThread(threadId) {
		return this.dispatch({ type: "thread.visit", threadId, visitedAt: new Date().toISOString() });
	}

	// ---------------------------------------------------------------- views

	projectName(t) {
		const p = this.projects.get(t?.projectId);
		return p?.title || p?.repositoryIdentity?.displayName || "";
	}

	/** Top-level threads (no subagents). */
	topThreads() {
		return [...this.threads.values()].filter((t) => !SUBAGENT(t));
	}

	threadLink(threadId) {
		const env = this.environmentId || readEnvironmentId();
		return `t3code://threads/${encodeURIComponent(env)}/${encodeURIComponent(threadId)}`;
	}
}

function describeFailure(exit) {
	const c = exit?.cause;
	const find = (x) => (x == null ? null : typeof x === "string" ? x : Array.isArray(x) ? x.map(find).find(Boolean) || null : x.message || x.error?.message || x.failure?.message || x.defect?.message || find(x.left) || find(x.right) || find(x.failure) || find(x.error) || null);
	return find(c) || JSON.stringify(c || exit || {}).slice(0, 200);
}

// ------------------------------------------------------------------ thread state

const WORKING = new Set(["preparing", "queued", "starting", "running", "waiting"]);
export const isWorking = (t) => WORKING.has(t?.status) || WORKING.has(t?.activityRunStatus);

/** input (question or approval waiting), failed, limited, working, done (finished, not read yet), idle. */
export function stateOf(t) {
	if (!t) return "idle";
	if (t.pendingRuntimeRequest) return "input";
	if (isWorking(t)) return "working";
	if (t.status === "failed") return t.lastErrorClass === "usage_limit" ? "limited" : "failed";
	if (t.status === "completed" || t.status === "interrupted" || t.status === "idle" || t.status === "cancelled") {
		const done = Date.parse(t.latestRunCompletedAt || "");
		const seen = Date.parse(t.lastVisitedAt || "");
		if (t.status === "completed" && Number.isFinite(done) && (!Number.isFinite(seen) || done > seen)) return "done";
	}
	return "idle";
}

const RANK = { input: 0, failed: 1, limited: 1, done: 2, working: 3, idle: 4 };

/** When the thread's current state began (for "new since" and the age label). */
export function stateSince(t, state = stateOf(t)) {
	if (state === "input") return t.pendingRuntimeRequest?.createdAt || t.updatedAt;
	if (state === "working") return t.activityRunStartedAt || t.latestRunStartedAt || t.latestRunRequestedAt || t.updatedAt;
	if (state === "done" || state === "failed" || state === "limited") return t.latestRunCompletedAt || t.updatedAt;
	return t.latestRunCompletedAt || t.updatedAt;
}

const snoozed = (t, now) => t.snoozedUntil && Date.parse(t.snoozedUntil) > now;

/**
 * The threads worth a key, most urgent first: needs you, failed, done (unread), working,
 * then unsettled idle ones. Settled threads (unless something new happened), snoozed
 * threads and subagents are left out.
 * Inside a group the most recent run comes first, so keys stay put while a thread works.
 */
export function inbox(threads, now = Date.now()) {
	const out = [];
	for (const t of threads) {
		if (SUBAGENT(t) || t.archivedAt || t.deletedAt) continue;
		const state = stateOf(t);
		// Like T3's sidebar: a settled thread is off the list until it needs you, works,
		// or finishes something new after it was settled.
		const newSinceSettled = Date.parse(t.latestRunCompletedAt || "") > Date.parse(t.settledAt || "");
		if (t.settledAt && state !== "input" && state !== "working" && !newSinceSettled) continue;
		if (state === "idle" && snoozed(t, now)) continue;
		if (state !== "input" && snoozed(t, now)) continue;
		out.push({ t, state, rank: RANK[state], when: Date.parse(t.latestRunRequestedAt || t.updatedAt || t.createdAt) || 0 });
	}
	out.sort((a, b) => a.rank - b.rank || b.when - a.when);
	return out;
}

export function counts(list) {
	const c = { input: 0, failed: 0, done: 0, working: 0, idle: 0 };
	for (const x of list) c[x.state === "limited" ? "failed" : x.state]++;
	return c;
}

/** The thread you looked at last: the one open in the app, most likely. */
export function currentThread(threads) {
	let best = null;
	let bestAt = -1;
	for (const t of threads) {
		if (SUBAGENT(t)) continue;
		const at = Math.max(Date.parse(t.lastVisitedAt || "") || 0, Number(t.opens?.openedAt) || 0);
		if (at > bestAt) {
			best = t;
			bestAt = at;
		}
	}
	return best;
}
