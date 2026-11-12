// Every hash, MAC, key derivation and signature input in TAIL (TECHNICAL.md 4.1–4.11).
// SHA-256, HMAC-SHA256, HKDF-SHA256, X25519 + ChaCha20-Poly1305, ed25519.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Writer } from "./borsh.ts";
import { concat, equal, fixed, readU64le, toHex, u16le, u32le, utf8 } from "./bytes.ts";
import { Domain, EPOCH_MS } from "./constants.ts";
import {
  type Batch,
  encodeBatch,
  encodeLogEntry,
  encodeVerdictPayload,
  type LogEntry,
  type VerdictPayload,
} from "./messages.ts";

export { sha256 };

// ── Match keys (4.1) ────────────────────────────────────────────────────────────

/** HKDF-SHA256 with an empty salt and the label as info, 32 bytes out. */
function derive(km: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, fixed(km, 32, "K_m"), new Uint8Array(0), info, 32);
}

/** Shared by every player in the match: recognises "a beacon from my match". */
export const deriveTagKey = (km: Uint8Array) => derive(km, utf8(Domain.tag));

/** Player i's beacon key. Only the enclave and player i hold it. */
export const derivePlayerKey = (km: Uint8Array, player: number) =>
  derive(km, concat(utf8(Domain.beacon), u16le(player)));

// ── Rotating beacon (4.2) ───────────────────────────────────────────────────────

export function epochAt(nowMs: number, startMs: number): number {
  if (nowMs < startMs) throw new RangeError("time before match start");
  return Math.floor((nowMs - startMs) / EPOCH_MS);
}

export const epochStartMs = (epoch: number, startMs: number) => startMs + epoch * EPOCH_MS;

/** First 4 bytes of every token in the match for this epoch. */
export const beaconTag = (kTag: Uint8Array, epoch: number) =>
  hmac(sha256, kTag, concat(utf8(Domain.tagMac), u32le(epoch))).slice(0, 4);

const beaconMac = (kPlayer: Uint8Array, epoch: number) =>
  hmac(sha256, kPlayer, concat(utf8(Domain.tokenMac), u32le(epoch))).slice(0, 12);

/** 16-byte token = tag(e) ‖ mac_i(e). Advertised as one 128-bit service UUID. */
export const beaconToken = (kTag: Uint8Array, kPlayer: Uint8Array, epoch: number) =>
  concat(beaconTag(kTag, epoch), beaconMac(kPlayer, epoch));

/** Token bytes → canonical upper-case UUID string, as CoreBluetooth prints it. */
export function tokenToUuid(token: Uint8Array): string {
  const h = toHex(fixed(token, 16, "token")).toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidToToken(uuid: string): Uint8Array {
  const h = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(h)) throw new Error(`not a 128-bit UUID: ${uuid}`);
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(h.slice(2 * i, 2 * i + 2), 16));
}

/** Phone-side filter: is this token from my match, for epochs e−1, e or e+1? */
export function tagMatches(kTag: Uint8Array, token: Uint8Array, epoch: number): boolean {
  const head = token.slice(0, 4);
  for (const e of [epoch - 1, epoch, epoch + 1]) if (e >= 0 && equal(head, beaconTag(kTag, e))) return true;
  return false;
}

/** Enclave-side: which player sent this token in epoch e? `undefined` if none. */
export function resolveToken(
  kPlayers: readonly Uint8Array[],
  kTag: Uint8Array,
  token: Uint8Array,
  epoch: number,
) {
  for (let i = 0; i < kPlayers.length; i++) {
    if (equal(token, beaconToken(kTag, kPlayers[i] as Uint8Array, epoch))) return i;
  }
  return undefined;
}

// ── Batches and App Attest (4.3, 4.4) ───────────────────────────────────────────

/** Hash-chain link and Merkle log id of a batch. */
export const batchHash = (b: Batch) => sha256(encodeBatch(b));

/** The clientDataHash an App Attest assertion over this batch signs. */
export const batchClientDataHash = (b: Batch) => sha256(concat(utf8(Domain.batch), encodeBatch(b)));

/** The clientDataHash the enrolment attestation signs: binds the device key to the account. */
export const enrollClientDataHash = (
  challenge: Uint8Array,
  accountId: string,
  playerBoxPk: Uint8Array,
  nearPk: Uint8Array,
) =>
  sha256(
    new Writer()
      .raw(utf8(Domain.enroll))
      .fixed(challenge, 32)
      .string(accountId)
      .fixed(playerBoxPk, 32)
      .fixed(nearPk, 32)
      .bytes(),
  );

// ── Verdicts (4.10) ─────────────────────────────────────────────────────────────

/** The 32 bytes the referee signs with ed25519 and the contract checks with ed25519_verify. */
export const verdictDigest = (p: VerdictPayload) =>
  sha256(concat(utf8(Domain.verdict), encodeVerdictPayload(p)));

/** Commits to the player list at Start. Account ids are sorted by their UTF-8 bytes. */
export function playersHash(accountIds: readonly string[]): Uint8Array {
  return sha256(
    new Writer()
      .raw(utf8(Domain.players))
      .vec(sortAccounts(accountIds), (w, a) => w.string(a))
      .bytes(),
  );
}

export function sortAccounts(accountIds: readonly string[]): string[] {
  return [...accountIds].sort((a, b) => {
    const x = utf8(a);
    const y = utf8(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
    return x.length - y.length;
  });
}

// ── Ring (4.8) ──────────────────────────────────────────────────────────────────

export const ringCommit = (vrfSignature: Uint8Array) =>
  sha256(concat(utf8(Domain.ring), fixed(vrfSignature, 64, "vrf signature")));

/**
 * Fisher–Yates over the players sorted by account id. Randomness: r_k = first 8 bytes (u64 LE)
 * of SHA256(seed ‖ u32le(k)), seed = SHA256(vrf_signature); swap index j = r_k mod (i + 1).
 * The modulo bias is below 2^-50 for 12 players. Player ring[k] hunts ring[k+1 mod n].
 */
export function buildRing(accountIds: readonly string[], vrfSignature: Uint8Array): string[] {
  const ring = sortAccounts(accountIds);
  const seed = sha256(fixed(vrfSignature, 64, "vrf signature"));
  let k = 0;
  for (let i = ring.length - 1; i > 0; i--) {
    const r = readU64le(sha256(concat(seed, u32le(k++))));
    const j = Number(r % BigInt(i + 1));
    [ring[i], ring[j]] = [ring[j] as string, ring[i] as string];
  }
  return ring;
}

// ── Merkle log (4.11), RFC 6962 ─────────────────────────────────────────────────

export const merkleLeaf = (e: LogEntry) => sha256(concat(Uint8Array.of(0), encodeLogEntry(e)));
const merkleNode = (l: Uint8Array, r: Uint8Array) => sha256(concat(Uint8Array.of(1), l, r));

/** Largest power of two strictly below n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  const k = split(leaves.length);
  return merkleNode(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** Audit path for leaf `index` in a tree of `leaves.length` (RFC 6962 2.1.1). */
export function merkleProof(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (index < 0 || index >= leaves.length) throw new RangeError("leaf index out of range");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...merkleProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))]
    : [...merkleProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

export function merkleVerify(
  leaf: Uint8Array,
  index: number,
  size: number,
  proof: readonly Uint8Array[],
  root: Uint8Array,
) {
  // Recompute bottom-up, following the same split as merkleProof.
  const walk = (i: number, n: number, depth: number): Uint8Array | undefined => {
    if (n === 1) return depth === proof.length ? leaf : undefined;
    const k = split(n);
    const sib = proof[proof.length - 1 - depth];
    if (!sib) return undefined;
    if (i < k) {
      const l = walk(i, k, depth + 1);
      return l && merkleNode(l, sib);
    }
    const r = walk(i - k, n - k, depth + 1);
    return r && merkleNode(sib, r);
  };
  if (index < 0 || index >= size) return false;
  const got = walk(index, size, 0);
  return got !== undefined && equal(got, root);
}

// ── Sealing (phone ↔ enclave) ───────────────────────────────────────────────────

const NONCE = new Uint8Array(12); // Each sealing key is used exactly once (fresh ephemeral key).

function sealKey(shared: Uint8Array, ephPk: Uint8Array, recipientPk: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(ephPk, recipientPk), utf8(Domain.seal), 32);
}

/**
 * sealed = eph_pk (32) ‖ ChaCha20-Poly1305(key, nonce 0, plaintext, aad = context).
 * key = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk), salt = eph_pk ‖ recipient_pk, info = "tail/seal/v1").
 * `context` names what is sealed ("tail/batch", "tail/hud", …) so a ciphertext cannot be
 * replayed as a different kind of message.
 */
export function sealWith(
  ephSk: Uint8Array,
  recipientPk: Uint8Array,
  plaintext: Uint8Array,
  context: string,
): Uint8Array {
  const ephPk = x25519.getPublicKey(fixed(ephSk, 32, "ephemeral key"));
  const key = sealKey(
    x25519.getSharedSecret(ephSk, fixed(recipientPk, 32, "recipient key")),
    ephPk,
    recipientPk,
  );
  return concat(ephPk, chacha20poly1305(key, NONCE, utf8(context)).encrypt(plaintext));
}

export const seal = (recipientPk: Uint8Array, plaintext: Uint8Array, context: string) =>
  sealWith(x25519.utils.randomSecretKey(), recipientPk, plaintext, context);

export function open(recipientSk: Uint8Array, sealed: Uint8Array, context: string): Uint8Array {
  if (sealed.length < 32 + 16) throw new Error("sealed message too short");
  const ephPk = sealed.slice(0, 32);
  const recipientPk = x25519.getPublicKey(fixed(recipientSk, 32, "recipient key"));
  const key = sealKey(x25519.getSharedSecret(recipientSk, ephPk), ephPk, recipientPk);
  return chacha20poly1305(key, NONCE, utf8(context)).decrypt(sealed.slice(32));
}

export const boxPublicKey = (sk: Uint8Array) => x25519.getPublicKey(fixed(sk, 32, "box key"));
