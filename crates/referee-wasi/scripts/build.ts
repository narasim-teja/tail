// Builds the referee component and appends manifest.json as its `outlayer.manifest` custom
// section. The lint table forbids unsafe code, and `#[link_section]` is an unsafe attribute, so
// the section is added here instead of in the source; the worker's reader (wasmparser
// `parse_all`) finds a top-level custom section of a component as well as a nested one, and
// the published wasm hash covers it either way.
//
// Run from anywhere: `bun crates/referee-wasi/scripts/build.ts`. Prints the output path and sha256.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const crate = join(dirname(import.meta.path), "..");
const SECTION = "outlayer.manifest";

const build = Bun.spawnSync(["cargo", "build", "--release", "--target", "wasm32-wasip2"], {
  cwd: crate,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) throw new Error("cargo build failed");

const input = new Uint8Array(
  await Bun.file(join(crate, "target/wasm32-wasip2/release/tail-referee.wasm")).arrayBuffer(),
);
// The manifest is checked here because a manifest the worker cannot read refuses every run.
const manifest = new TextEncoder().encode(
  JSON.stringify(JSON.parse(await Bun.file(join(crate, "manifest.json")).text())),
);

const leb = (n: number) => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const readLeb = (b: Uint8Array, at: number): [number, number] => {
  let n = 0;
  let shift = 0;
  for (;;) {
    const byte = b[at++] as number;
    n |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [n >>> 0, at];
    shift += 7;
  }
};

// Header: "\0asm", then version 0x0d 0x00 and layer 0x01 0x00 for a component.
const magic = [0x00, 0x61, 0x73, 0x6d];
if (!magic.every((m, i) => input[i] === m)) throw new Error("not a wasm binary");
if (input[6] !== 0x01) throw new Error("expected a component (wasm32-wasip2), got a core module");

// Refuse to add a second manifest section at the top level.
for (let at = 8; at < input.length; ) {
  const id = input[at] as number;
  const [size, body] = readLeb(input, at + 1);
  if (id === 0) {
    const [nameLen, nameAt] = readLeb(input, body);
    const name = new TextDecoder().decode(input.slice(nameAt, nameAt + nameLen));
    if (name === SECTION) throw new Error(`${SECTION} is already present`);
  }
  at = body + size;
}

const name = new TextEncoder().encode(SECTION);
const content = [...leb(name.length), ...name, ...manifest];
const section = Uint8Array.from([0x00, ...leb(content.length), ...content]);
const out = new Uint8Array(input.length + section.length);
out.set(input);
out.set(section, input.length);

const outPath = join(crate, "target/tail-referee.wasm");
await Bun.write(outPath, out);
console.log(`wrote ${outPath} (${out.length} bytes, manifest ${manifest.length} bytes)`);
console.log(`sha256 ${createHash("sha256").update(out).digest("hex")}`);
