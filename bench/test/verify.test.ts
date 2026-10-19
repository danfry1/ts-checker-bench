import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { splitBinary, untar } from "../verify.ts";

/** A minimal ustar archive: one 512-byte header per file, then its content padded to 512 bytes. */
function tar(entries: { name: string; type?: string; body: string }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const e of entries) {
		const header = Buffer.alloc(512);
		header.write(e.name.slice(0, 100), 0);
		header.write(Buffer.byteLength(e.body).toString(8).padStart(11, "0") + "\0", 124);
		header.write(e.type ?? "0", 156);
		header.write("ustar\0", 257);
		const body = Buffer.alloc(Math.ceil(Buffer.byteLength(e.body) / 512) * 512);
		body.write(e.body);
		blocks.push(header, body);
	}
	return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("untar reads files from an npm tarball, including a pax long path", () => {
	const long = `package/${"d/".repeat(60)}tsc`;
	const files = untar(tar([
		{ name: "package/lib/tsc", body: "binary" },
		{ name: "PaxHeader", type: "x", body: `${long.length + 10} path=${long}\n` },
		{ name: "ignored-short-name", body: "deep" },
	]));
	assert.equal(files.get("package/lib/tsc")?.toString(), "binary");
	assert.equal(files.get(long)?.toString(), "deep");
});

test("a binary path splits into its package and the file inside it", () => {
	assert.deepEqual(splitBinary("@typescript/typescript-linux-x64/lib/tsc"), ["@typescript/typescript-linux-x64", "lib/tsc"]);
	assert.deepEqual(splitBinary("bun/bin/bun.exe"), ["bun", "bin/bun.exe"]);
});
