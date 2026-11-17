// Builds the plugin folder com.coreloop.t3.sdPlugin:
//   native/fgwatch.cs -> bin/fgwatch.exe (csc from .NET Framework 4, part of Windows)
//   src/              -> bin/plugin.js (rollup)
//   ui/, fonts, resvg.wasm, layouts, action images, manifest.json
// then the profiles (tools/build-profiles.mjs). Usage: node tools/build.mjs [--no-bundle] [--no-profiles]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DECKS, PROFILES, profileName } from "../src/decks.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const SD = path.join(ROOT, "com.coreloop.t3.sdPlugin");
const UUID = "com.coreloop.t3";
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
// Inter, under the SIL Open Font License (assets/fonts/OFL.txt).
const FONTS = path.join(ROOT, "assets", "fonts");

const write = (rel, data) => {
	const p = path.join(SD, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, data);
};

// ------------------------------------------------------------------ static files
fs.mkdirSync(SD, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "ui"))) write(`ui/${f}`, fs.readFileSync(path.join(ROOT, "ui", f)));
for (const f of ["Inter-Medium.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf", "OFL.txt"]) write(`fonts/${f}`, fs.readFileSync(path.join(FONTS, f)));
write("bin/resvg.wasm", fs.readFileSync(path.join(ROOT, "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm")));
write("bin/package.json", JSON.stringify({ type: "module" }));
// Left out of the packed .streamDeckPlugin: logs and a swapped-out helper exe.
write(".sdignore", ["logs/", "bin/fgwatch.old-*.exe", "bin/fgwatch.new.exe", ""].join("\n"));
write("layouts/canvas.json", JSON.stringify({ $schema: "https://schemas.elgato.com/streamdeck/plugins/layout.json", id: "t3-deck-canvas", items: [{ key: "canvas", type: "pixmap", rect: [0, 0, 200, 100] }] }, null, 2));

// ------------------------------------------------------------------ native helper
if (process.platform === "win32") {
	const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
	const src = path.join(ROOT, "native", "fgwatch.cs");
	const exe = path.join(SD, "bin", "fgwatch.exe");
	// Leftovers from swapping a running exe (see below).
	for (const f of fs.readdirSync(path.join(SD, "bin"))) {
		if (!/^fgwatch\.old-\d+\.exe$/.test(f)) continue;
		try {
			fs.rmSync(path.join(SD, "bin", f), { force: true });
		} catch {} // still running; goes next time
	}
	if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs > fs.statSync(src).mtimeMs) console.log("native: bin/fgwatch.exe is up to date");
	else {
		if (!fs.existsSync(csc)) throw new Error(`csc.exe not found at ${csc}`);
		const fresh = path.join(SD, "bin", "fgwatch.new.exe");
		execFileSync(csc, ["-nologo", "-target:winexe", "-optimize", `-out:${fresh}`, src], { stdio: "inherit" });
		// A running plugin keeps the exe locked, but Windows lets a running exe be renamed.
		if (fs.existsSync(exe)) fs.renameSync(exe, path.join(SD, "bin", `fgwatch.old-${Date.now()}.exe`));
		fs.renameSync(fresh, exe);
		console.log("native: bin/fgwatch.exe (restart the plugin to use it)");
	}
} else {
	console.warn("native: not on Windows, bin/fgwatch.exe not built (profile switching by app needs Windows)");
}

// ------------------------------------------------------------------ images
const R = await import("../src/render.js");
await R.initRender(
	fs.readFileSync(path.join(SD, "bin", "resvg.wasm")),
	["Inter-Medium", "Inter-SemiBold", "Inter-Bold"].map((f) => fs.readFileSync(path.join(FONTS, `${f}.ttf`))),
);
const png2 = (rel, svg, w) => {
	write(`${rel}.png`, R.renderPng(svg, w));
	write(`${rel}@2x.png`, R.renderPng(svg, w * 2));
};
// Action-list icons: white line art on transparent, as the Stream Deck app expects.
const listIcon = (g, size = 20) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">${R.glyph(g, 0, 0, 48, "#ffffff", "#d0d0d0")}</svg>`;

png2("imgs/plugin/icon", `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="28" fill="#1b1d21"/>${R.glyph("t3", 22, 22, 100, "#fff", R.C.brand)}</svg>`, 128);
write("imgs/plugin/category.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 48 48"><rect x="3" y="3" width="42" height="42" rx="10" fill="none" stroke="#fff" stroke-width="3.5"/><text x="24" y="31" font-family="Inter, Segoe UI, sans-serif" font-size="19" font-weight="700" fill="#fff" text-anchor="middle">T3</text></svg>`);

const SAMPLE = { title: "Fix the login redirect", project: "my-app" };
const KEYS = [
	["status", "T3 Status", "Counts threads that need you, failed, finished or are working. Press: open the one that needs you most.", "t3", R.statusKey({ c: { input: 1, done: 2, working: 3 } })],
	["thread", "Thread", "One thread from the list, most urgent first. Press: open it. Hold: mark it done.", "list", R.threadKey({ ...SAMPLE, state: "done", ago: "2m" })],
	["reply", "Quick Reply", "Sends a fixed message to the thread you looked at last.", "reply", R.replyKey({ text: "Continue", target: SAMPLE.title })],
	["stop", "Stop", "Stops the thread that is working.", "stop", R.iconKey({ glyph: "stop", label: "Stop", accent: R.C.failed, active: true })],
	["settle", "Mark Done", "Settles the thread: it leaves the list until something new happens.", "check", R.iconKey({ glyph: "check", label: "Mark done", accent: R.C.done })],
	["new", "New Thread", "New chat, or a new draft with your prompt.", "plus", R.iconKey({ glyph: "plus", label: "New thread" })],
	["open", "Open T3 Code", "Brings T3 Code to the front.", "open", R.iconKey({ glyph: "t3", label: "T3 Code" })],
	["shortcut", "T3 Shortcut", "Presses one of T3 Code's keyboard shortcuts (next thread, palette, terminal…).", "keyboard", R.iconKey({ glyph: "next", label: "Next\nthread" })],
];
const DIALS = [
	["threads", "Threads Dial", "list", { Rotate: "Walk the thread list", Push: "Open the thread", Touch: "Open (long touch: mark done)" }],
	["reply", "Reply Dial", "reply", { Rotate: "Pick a reply", Push: "Send it", Touch: "Open the thread it goes to" }],
	["nav", "Thread Navigator", "next", { Rotate: "Next / previous thread in T3 Code", Push: "Mark the thread done", Touch: "Jump to the thread that needs you" }],
];

const actions = [];
for (const [id, name, tip, g, svg] of KEYS) {
	write(`imgs/actions/${id}.svg`, listIcon(g));
	png2(`imgs/actions/${id}-key`, svg, 72);
	actions.push({
		UUID: `${UUID}.${id}`,
		Name: name,
		Tooltip: tip,
		Icon: `imgs/actions/${id}`,
		PropertyInspectorPath: id === "status" ? "ui/status.html" : "ui/key.html",
		Controllers: ["Keypad"],
		States: [{ Image: `imgs/actions/${id}-key`, ShowTitle: false }],
		UserTitleEnabled: false,
	});
}
for (const [id, name, g, trig] of DIALS) {
	write(`imgs/actions/dial-${id}.svg`, listIcon(g));
	png2(`imgs/dials/${id}`, R.dialIconSvg(g), 72);
	actions.push({
		UUID: `${UUID}.dial.${id}`,
		Name: name,
		Icon: `imgs/actions/dial-${id}`,
		PropertyInspectorPath: "ui/key.html",
		Controllers: ["Encoder"],
		Encoder: { Icon: `imgs/dials/${id}`, layout: "layouts/canvas.json", TriggerDescription: trig, StackColor: R.C.brand },
		States: [{ Image: `imgs/dials/${id}` }],
	});
}

const manifest = {
	$schema: "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
	Name: "T3 Deck",
	Version: `${VERSION}.0`,
	Author: "Core Loop",
	Description: "T3 Code on your Stream Deck: live thread status (needs you, failed, done, working), open threads, quick replies, stop and mark done, T3's shortcuts and dials. The deck follows the program in front: T3 Code gets its own profile.",
	URL: "https://github.com/maxzinko/t3-deck",
	UUID,
	Icon: "imgs/plugin/icon",
	Category: "T3 Deck",
	CategoryIcon: "imgs/plugin/category",
	CodePath: "bin/plugin.js",
	SDKVersion: 3,
	Software: { MinimumVersion: "7.1" },
	OS: [{ Platform: "windows", MinimumVersion: "10" }],
	Nodejs: { Version: "24" },
	Profiles: DECKS.flatMap((d) => PROFILES.map((p) => ({ Name: profileName(p, d.type), DeviceType: d.type, Readonly: false, DontAutoSwitchWhenInstalled: true, AutoInstall: true }))),
	Actions: actions,
};
write("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
console.log(`manifest: ${actions.length} actions`);

// ------------------------------------------------------------------ bundle + profiles
if (!args.has("--no-bundle")) {
	execFileSync(process.execPath, [path.join(ROOT, "node_modules", "rollup", "dist", "bin", "rollup"), "-c", path.join(ROOT, "rollup.config.mjs")], { cwd: ROOT, stdio: "inherit" });
}
if (!args.has("--no-profiles")) {
	execFileSync(process.execPath, [path.join(ROOT, "tools", "build-profiles.mjs")], { cwd: ROOT, stdio: "inherit" });
}
