// Minimal zip writer (deflate) for the add-on zip and .streamDeckProfile files.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{name: "a/b.txt", data: Buffer}] -> zip Buffer. Directories are implied. */
export function zipBuffer(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	// Fixed timestamp (2026-01-01) keeps builds reproducible.
	const dosTime = 0;
	const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
	for (const e of entries) {
		const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
		const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
		const comp = zlib.deflateRawSync(raw, { level: 9 });
		const useDeflate = comp.length < raw.length;
		const body = useDeflate ? comp : raw;
		const crc = crc32(raw);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0x0800, 6); // UTF-8 names
		lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
		lh.writeUInt16LE(dosTime, 10);
		lh.writeUInt16LE(dosDate, 12);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(body.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(name.length, 26);
		lh.writeUInt16LE(0, 28);
		locals.push(lh, name, body);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0x0800, 8);
		ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
		ch.writeUInt16LE(dosTime, 12);
		ch.writeUInt16LE(dosDate, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(body.length, 20);
		ch.writeUInt32LE(raw.length, 24);
		ch.writeUInt16LE(name.length, 28);
		ch.writeUInt32LE(offset, 42);
		centrals.push(ch, name);
		offset += lh.length + name.length + body.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

/** Zip a folder. prefix: path inside the zip ("" = folder contents at the root). */
export function zipFolder(dir, prefix = "", filter = () => true) {
	const entries = [];
	const walk = (d, rel) => {
		for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const p = path.join(d, f.name);
			const r = rel ? `${rel}/${f.name}` : f.name;
			if (!filter(r, f)) continue;
			if (f.isDirectory()) walk(p, r);
			else entries.push({ name: prefix ? `${prefix}/${r}` : r, data: fs.readFileSync(p) });
		}
	};
	walk(dir, "");
	return zipBuffer(entries);
}

/** Read a zip Buffer -> [{name, data}] (stored or deflated entries). */
export function unzipBuffer(buf) {
	let eocd = buf.length - 22;
	while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
	if (eocd < 0) throw new Error("not a zip file");
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const out = [];
	for (let i = 0; i < count; i++) {
		const method = buf.readUInt16LE(p + 10);
		const csize = buf.readUInt32LE(p + 20);
		const nlen = buf.readUInt16LE(p + 28);
		const xlen = buf.readUInt16LE(p + 30);
		const clen = buf.readUInt16LE(p + 32);
		const off = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nlen);
		const lnlen = buf.readUInt16LE(off + 26);
		const lxlen = buf.readUInt16LE(off + 28);
		const body = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
		if (!name.endsWith("/")) out.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body) });
		p += 46 + nlen + xlen + clen;
	}
	return out;
}
