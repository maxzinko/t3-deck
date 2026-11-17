// Tiny Property Inspector helper: talks to the Stream Deck app over its WebSocket.
const PI = {
	ws: null,
	uuid: null,
	action: null,
	settings: {},
	global: {},
	info: null,
	handlers: { settings: [], global: [], message: [], ready: [] },
	on(name, fn) {
		this.handlers[name].push(fn);
	},
	emit(name, arg) {
		for (const fn of this.handlers[name]) fn(arg);
	},
	send(obj) {
		if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
	},
	setSettings(patch) {
		this.settings = Object.assign({}, this.settings, patch);
		this.send({ event: "setSettings", context: this.uuid, payload: this.settings });
	},
	setGlobal(patch) {
		this.global = Object.assign({}, this.global, patch);
		this.send({ event: "setGlobalSettings", context: this.uuid, payload: this.global });
	},
	toPlugin(payload) {
		this.send({ action: this.action, event: "sendToPlugin", context: this.uuid, payload });
	},
	openUrl(url) {
		this.send({ event: "openUrl", payload: { url } });
	},
};

window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, info, actionInfo) {
	PI.uuid = uuid;
	try {
		PI.info = JSON.parse(info);
	} catch (e) {}
	const ai = JSON.parse(actionInfo);
	PI.action = ai.action;
	PI.settings = (ai.payload && ai.payload.settings) || {};
	PI.ws = new WebSocket("ws://127.0.0.1:" + port);
	PI.ws.onopen = () => {
		PI.send({ event: registerEvent, uuid });
		PI.send({ event: "getGlobalSettings", context: uuid });
		PI.emit("ready");
	};
	PI.ws.onmessage = (m) => {
		const d = JSON.parse(m.data);
		if (d.event === "didReceiveSettings") {
			PI.settings = d.payload.settings || {};
			PI.emit("settings", PI.settings);
		} else if (d.event === "didReceiveGlobalSettings") {
			PI.global = d.payload.settings || {};
			PI.emit("global", PI.global);
		} else if (d.event === "sendToPropertyInspector") {
			PI.emit("message", d.payload);
		}
	};
};

// Small DOM helpers shared by the inspectors.
function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (k === "class") el.className = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
	}
	for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
	return el;
}

function row(label, field) {
	return h("div", { class: "row" }, h("label", {}, label), h("div", { class: "field" }, field));
}

function seg(options, value, onPick, multi = false) {
	const wrap = h("div", { class: "seg" });
	const vals = new Set(multi ? value || [] : [value]);
	for (const [v, text] of options) {
		const b = h("button", { class: vals.has(v) ? "on" : "" }, text);
		b.addEventListener("click", () => {
			if (multi) {
				if (vals.has(v)) vals.delete(v);
				else vals.add(v);
				b.classList.toggle("on");
				onPick(options.map((o) => o[0]).filter((x) => vals.has(x)));
			} else {
				for (const x of wrap.children) x.classList.remove("on");
				b.classList.add("on");
				onPick(v);
			}
		});
		wrap.append(b);
	}
	return wrap;
}

function copyText(text) {
	const ta = h("textarea", {}, text);
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.append(ta);
	ta.select();
	try {
		document.execCommand("copy");
	} catch (e) {}
	ta.remove();
	if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}
