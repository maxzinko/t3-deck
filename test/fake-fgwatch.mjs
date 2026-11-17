// Stands in for bin/fgwatch.exe in tests. Prints each new line the test appends to
// $T3DECK_WINDOWS (window JSON, like the real watcher), and appends the commands it
// gets on stdin ("keys ctrl+shift+]") to $T3DECK_KEYS_LOG. Exits when stdin closes.
import fs from "node:fs";
import readline from "node:readline";

const winFile = process.env.T3DECK_WINDOWS;
const keysLog = process.env.T3DECK_KEYS_LOG;
let done = 0;
setInterval(() => {
	let lines = [];
	try {
		lines = fs.readFileSync(winFile, "utf8").split("\n").filter(Boolean);
	} catch {}
	for (; done < lines.length; done++) process.stdout.write(lines[done] + "\n");
}, 40);
readline
	.createInterface({ input: process.stdin })
	.on("line", (l) => keysLog && fs.appendFileSync(keysLog, l + "\n"))
	.on("close", () => process.exit(0));
