// Mesh carry (TECHNICAL.md 7): a phone without signal hands its signed relay request to nearby
// phones, which forward it until one reaches the relay.
//
//   envelope = seal(relay_box_pk, pad(borsh(CarryRequest), 4096), context "tail/carry/v1")
//   pad(x)   = u32le(len(x)) ‖ x ‖ zeros, 4096 bytes in all
//   ack sig  = ed25519(relay_sk, SHA256("tail/carry-ack/v1" ‖ SHA256(envelope) ‖ u16le(status) ‖ u64le(received_ms)))
//
// Carriers see only a fixed-size ciphertext: not who sent it, not what kind of request it is,
// not even its length. The ack lets the sender (and a carrier) prove the relay received it.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Writer } from "./borsh.ts";
import { utf8 } from "./bytes.ts";
import { Domain, SealContext } from "./constants.ts";
import { open, seal, sealWith, verifyEd25519 } from "./crypto.ts";
import { type CarryAck, type CarryRequest, decodeCarryRequest, encodeCarryRequest } from "./messages.ts";

type Bytes = Uint8Array;

/** Plaintext size of every carry envelope (sealed: 32 + 4096 + 16 bytes). */
export const CARRY_PAD = 4096;

export function padCarry(x: Bytes): Bytes {
  if (x.length > CARRY_PAD - 4)
    throw new RangeError(`carried request is ${x.length} bytes, at most ${CARRY_PAD - 4}`);
  const out = new Uint8Array(CARRY_PAD);
  new DataView(out.buffer).setUint32(0, x.length, true);
  out.set(x, 4);
  return out;
}

/** Strict: the length must fit and every padding byte must be zero. */
export function unpadCarry(padded: Bytes): Bytes {
  if (padded.length !== CARRY_PAD) throw new Error(`carry plaintext must be ${CARRY_PAD} bytes`);
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, true);
  if (len > CARRY_PAD - 4) throw new Error("carry length out of range");
  if (padded.subarray(4 + len).some((b) => b !== 0)) throw new Error("carry padding is not zero");
  return padded.slice(4, 4 + len);
}

export const sealCarry = (relayBoxPk: Bytes, req: CarryRequest) =>
  seal(relayBoxPk, padCarry(encodeCarryRequest(req)), SealContext.carry);

/** Fixed ephemeral key, for vectors and tests only. */
export const sealCarryWith = (ephSk: Bytes, relayBoxPk: Bytes, req: CarryRequest) =>
  sealWith(ephSk, relayBoxPk, padCarry(encodeCarryRequest(req)), SealContext.carry);

export const openCarry = (relayBoxSk: Bytes, envelope: Bytes) =>
  decodeCarryRequest(unpadCarry(open(relayBoxSk, envelope, SealContext.carry)));

export const carryAckDigest = (envelope: Bytes, status: number, receivedMs: bigint) =>
  sha256(new Writer().raw(utf8(Domain.carryAck)).raw(sha256(envelope)).u16(status).u64(receivedMs).bytes());

export const signCarryAck = (
  relaySk: Bytes,
  envelope: Bytes,
  status: number,
  receivedMs: bigint,
): CarryAck => ({
  status,
  receivedMs,
  sig: ed25519.sign(carryAckDigest(envelope, status, receivedMs), relaySk),
});

export const verifyCarryAck = (relayPk: Bytes, envelope: Bytes, ack: CarryAck) =>
  verifyEd25519(relayPk, carryAckDigest(envelope, ack.status, ack.receivedMs), ack.sig);
