// A small typed borsh codec. The Rust side uses the `borsh` crate; the golden vectors prove
// the two agree. Only the shapes TAIL uses are supported: integers, fixed byte arrays,
// length-prefixed bytes/strings/vectors, options and enums (u8 tag).

import { concat, utf8 } from "./bytes.ts";

export class Writer {
  private parts: Uint8Array[] = [];

  bytes(): Uint8Array {
    return concat(...this.parts);
  }
  raw(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  u8(n: number): this {
    return this.int(n, 1, false);
  }
  i8(n: number): this {
    return this.int(n, 1, true);
  }
  u16(n: number): this {
    return this.int(n, 2, false);
  }
  u32(n: number): this {
    return this.int(n, 4, false);
  }
  i32(n: number): this {
    return this.int(n, 4, true);
  }
  u64(n: bigint): this {
    if (n < 0n || n >= 1n << 64n) throw new RangeError(`u64 out of range: ${n}`);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return this.raw(b);
  }
  u128(n: bigint): this {
    if (n < 0n || n >= 1n << 128n) throw new RangeError(`u128 out of range: ${n}`);
    return this.u64(n & 0xffff_ffff_ffff_ffffn).u64(n >> 64n);
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  /** `[u8; N]`: no length prefix. */
  fixed(b: Uint8Array, len: number): this {
    if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
    return this.raw(b);
  }
  /** `Vec<u8>`: u32 length prefix. */
  vecU8(b: Uint8Array): this {
    return this.u32(b.length).raw(b);
  }
  string(s: string): this {
    return this.vecU8(utf8(s));
  }
  vec<T>(items: readonly T[], each: (w: Writer, item: T) => void): this {
    this.u32(items.length);
    for (const it of items) each(this, it);
    return this;
  }
  option<T>(v: T | undefined, each: (w: Writer, item: T) => void): this {
    if (v === undefined) return this.u8(0);
    this.u8(1);
    each(this, v);
    return this;
  }

  private int(n: number, size: 1 | 2 | 4, signed: boolean): this {
    const min = signed ? -(2 ** (size * 8 - 1)) : 0;
    const max = signed ? 2 ** (size * 8 - 1) - 1 : 2 ** (size * 8) - 1;
    if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`int${size * 8} out of range: ${n}`);
    const b = new Uint8Array(size);
    const v = new DataView(b.buffer);
    if (size === 1) signed ? v.setInt8(0, n) : v.setUint8(0, n);
    else if (size === 2) signed ? v.setInt16(0, n, true) : v.setUint16(0, n, true);
    else signed ? v.setInt32(0, n, true) : v.setUint32(0, n, true);
    return this.raw(b);
  }
}

export class Reader {
  private off = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Throws unless every byte was consumed: trailing bytes are a malformed message. */
  done(): void {
    if (this.off !== this.buf.length) throw new Error(`${this.buf.length - this.off} trailing bytes`);
  }
  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  i8(): number {
    return this.view.getInt8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }
  u128(): bigint {
    const lo = this.u64();
    return lo | (this.u64() << 64n);
  }
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new Error(`invalid bool ${v}`);
    return v === 1;
  }
  fixed(len: number): Uint8Array {
    const at = this.take(len);
    return this.buf.slice(at, at + len);
  }
  vecU8(): Uint8Array {
    return this.fixed(this.u32());
  }
  string(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.vecU8());
  }
  vec<T>(each: (r: Reader) => T): T[] {
    const n = this.u32();
    // Each element is at least one byte, so a count beyond the remaining bytes is malformed.
    if (n > this.buf.length - this.off) throw new Error(`vector length ${n} exceeds input`);
    return Array.from({ length: n }, () => each(this));
  }
  option<T>(each: (r: Reader) => T): T | undefined {
    const tag = this.u8();
    if (tag > 1) throw new Error(`invalid option tag ${tag}`);
    return tag === 1 ? each(this) : undefined;
  }

  private take(n: number): number {
    if (this.off + n > this.buf.length) throw new Error("unexpected end of input");
    const at = this.off;
    this.off += n;
    return at;
  }
}
