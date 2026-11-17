// Renders a preview sheet of the key and touch-strip designs (sample data).
//   node test/sheet.mjs [out.png]     (build first; default test/out/sheet.png)
import fs from "node:fs";
import * as R from "../src/render.js";
const SD = "com.coreloop.t3.sdPlugin";
await R.initRender(fs.readFileSync(`${SD}/bin/resvg.wasm`), ["Inter-Medium", "Inter-SemiBold", "Inter-Bold"].map((f) => fs.readFileSync(`${SD}/fonts/${f}.ttf`)));
const keys = [
  R.statusKey({ c: { input: 1, done: 2, working: 3 }, pulse: 1 }),
  R.statusKey({ c: { done: 2 } }),
  R.statusKey({ c: { working: 4 } }),
  R.statusKey({ c: {} }),
  R.statusKey({ online: false, note: "sign-in needed" }),
  R.threadKey({ title: "Add dark mode to the settings page", state: "working", project: "web-app", ago: "12m" }),
  R.threadKey({ title: "Fix the login redirect loop on Safari", state: "done", project: "web-app", ago: "2m" }),
  R.threadKey({ title: "Which database should we use?", state: "input", project: "web-app", ago: "now" }),
  R.threadKey({ title: "Refactor", state: "failed", project: "api", ago: "1h" }),
  R.threadKey({ empty: true, slot: 4 }),
  R.replyKey({ text: "Continue", target: "Add dark mode to the settings page" }),
  R.replyKey({ text: "Run the tests and fix what fails", target: "Fix login" }),
  R.iconKey({ glyph: "stop", label: "Stop", accent: R.C.failed, sub: "Add dark mode", active: true }),
  R.iconKey({ glyph: "stop", label: "Stop", accent: R.C.faint, sub: "Fix login", dim: true }),
  R.iconKey({ glyph: "check", label: "Mark done", accent: R.C.done, sub: "Fix login" }),
  R.iconKey({ glyph: "plus", label: "New thread" }),
  R.iconKey({ glyph: "palette", label: "Command\npalette", sub: "ctrl+k" }),
  R.iconKey({ glyph: "sidebar", label: "Sidebar", sub: "ctrl+b" }),
  R.iconKey({ glyph: "terminal", label: "Terminal", sub: "ctrl+j" }),
  R.iconKey({ glyph: "diff", label: "Diff", sub: "ctrl+d" }),
  R.iconKey({ glyph: "files", label: "Files", sub: "ctrl+p" }),
  R.iconKey({ glyph: "search", label: "Find", sub: "ctrl+f" }),
  R.iconKey({ glyph: "model", label: "Model", sub: "ctrl+shift+m" }),
  R.iconKey({ glyph: "keyboard", label: "Mode", sub: "ctrl+shift+a" }),
];
const strips = [
  R.stripThread({ caption: "Threads", pos: "2/7", title: "Add dark mode to the settings page", state: "working", sub: "12m · web-app" }),
  R.stripThread({ caption: "Threads", empty: true, title: "all clear" }),
  R.stripReply({ text: "Run the tests and fix what fails", target: "Add dark mode", pos: "3/5" }),
  R.stripReply({ flash: "Sent" }),
];
const cols = 6, W = 144, G = 10;
const rows = Math.ceil(keys.length / cols);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * (W + G) + G}" height="${rows * (W + G) + G + 120}"><rect width="100%" height="100%" fill="#444"/>`;
keys.forEach((k, i) => { svg += `<image x="${G + (i % cols) * (W + G)}" y="${G + Math.floor(i / cols) * (W + G)}" width="144" height="144" href="${R.pngDataUrl(k)}"/>`; });
strips.forEach((s, i) => { svg += `<image x="${G + i * 210}" y="${G + rows * (W + G)}" width="200" height="100" href="${R.pngDataUrl(s, 200)}"/>`; });
svg += "</svg>";
fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(process.argv[2] || "test/out/sheet.png", R.renderPng(svg, cols * (W + G) + G));
