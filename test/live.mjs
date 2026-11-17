// Read-only check against the real T3 Code on this PC: gets a 10-minute read-only token
// from T3's CLI, subscribes like the plugin does, and prints what the keys would show.
// It sends no commands. The token is never printed.
//   node test/live.mjs
import { execFile } from "node:child_process";
import path from "node:path";
import { T3Client, T3_HOME, counts, currentThread, inbox } from "../src/t3.js";

const t0 = Date.now();
const token = await new Promise((resolve, reject) =>
	execFile(`"${path.join(T3_HOME, "bin", "t3.cmd")}"`, ["auth", "session", "issue", "--scope", "orchestration:read", "--ttl", "10m", "--label", "StreamDeckTest", "--json"], { shell: true, windowsHide: true }, (err, out) =>
		err ? reject(err) : resolve(JSON.parse(String(out).slice(String(out).indexOf("{"))).token),
	),
);
const client = new T3Client({ log: console, getToken: () => token, onNeedToken: () => Promise.reject(new Error("token refused")) });
client.start();
const end = Date.now() + 15000;
while (client.status !== "online" && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 1500)); // the rest of the snapshot
if (client.status !== "online") {
	console.error(`not online: ${client.status} ${client.error}`);
	process.exit(1);
}
const top = client.topThreads();
const list = inbox(top);
console.log(`online in ${Date.now() - t0} ms: ${client.threads.size} threads (${top.length} top-level), ${client.projects.size} projects`);
console.log("counts:", JSON.stringify(counts(list)));
list.slice(0, 8).forEach((x, i) => console.log(`  slot ${i + 1}: [${x.state}] ${x.t.title} (${client.projectName(x.t)})`));
console.log(`current thread: ${currentThread(top)?.title}`);
client.stop();
process.exit(0);
