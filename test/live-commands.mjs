// Checks the command shapes against the real T3 Code without changing anything: each
// command goes to a thread id that doesn't exist. A shape T3 can't read fails with a
// schema error; a good shape gets past it and fails only because the thread is missing.
// Uses a 10-minute token (read + operate) from T3's CLI; the token is never printed.
//   node test/live-commands.mjs
import { execFile } from "node:child_process";
import { T3Client } from "../src/t3.js";

const token = await new Promise((resolve, reject) => {
	const cli = `"${process.env.USERPROFILE}\\.t3\\bin\\t3.cmd"`;
	execFile(cli, ["auth", "session", "issue", "--scope", "orchestration:read", "--scope", "orchestration:operate", "--ttl", "10m", "--label", "StreamDeckTest", "--json"], { shell: true, windowsHide: true }, (err, out) =>
		err ? reject(err) : resolve(JSON.parse(String(out).slice(String(out).indexOf("{"))).token),
	);
});
const client = new T3Client({ log: console, getToken: () => token, onNeedToken: () => Promise.reject(new Error("refused")) });
client.start();
const end = Date.now() + 15000;
while (client.status !== "online" && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
if (client.status !== "online") throw new Error(`not online: ${client.status}`);

const GHOST = "stream-deck-shape-check-does-not-exist";
// What the plugin sends, built by the same code.
const tries = {
	"message.dispatch (start)": () => client.sendMessage(GHOST, "shape check"),
	"thread.stop": () => client.stopThread(GHOST),
	"thread.settle": () => client.settleThread(GHOST),
	"thread.visit": () => client.visitThread(GHOST),
	"message.dispatch (queued)": () => {
		client.threads.set(GHOST, { id: GHOST, status: "running" }); // pretend it's busy, to build the queued shape
		const p = client.sendMessage(GHOST, "shape check");
		client.threads.delete(GHOST);
		return p;
	},
	"control: a made-up command type": () => client.dispatch({ type: "thread.no-such-command", threadId: GHOST }),
};
let bad = 0;
for (const [name, fn] of Object.entries(tries)) {
	let res;
	try {
		res = `accepted?! ${JSON.stringify(await fn()).slice(0, 120)}`;
	} catch (e) {
		res = e.message;
	}
	const schema = /schema|decode|expected|parse|missing|is not|Invalid/i.test(res) && !/not found|unknown thread|does not exist|no thread/i.test(res);
	const control = name.startsWith("control");
	if (schema !== control) bad++;
	console.log(`${schema === control ? "ok  " : "FAIL"} ${name}: ${res.replace(/\s+/g, " ").slice(0, 220)}`);
}
client.stop();
process.exit(bad ? 1 : 0);
