// Fixed-size plaintexts, so a ciphertext's length says nothing about what it holds:
//
//   pad(x, size) = u32le(len(x)) ‖ x ‖ zeros, `size` bytes in all
//
// Used for mesh-carried requests (CARRY_PAD) and for everything the referee seals to a phone
// (PHONE_PAD). Unpadding is strict: the size must match, the length must fit, and every padding
// byte must be zero.

type Bytes = Uint8Array;

export function padTo(size: number, x: Bytes, what: string): Bytes {
  if (x.length > size - 4) throw new RangeError(`${what} is ${x.length} bytes, at most ${size - 4}`);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, x.length, true);
  out.set(x, 4);
  return out;
}

export function unpadFrom(size: number, padded: Bytes, what: string): Bytes {
  if (padded.length !== size) throw new Error(`${what} plaintext must be ${size} bytes`);
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, true);
  if (len > size - 4) throw new Error(`${what} length out of range`);
  if (padded.subarray(4 + len).some((b) => b !== 0)) throw new Error(`${what} padding is not zero`);
  return padded.slice(4, 4 + len);
}
