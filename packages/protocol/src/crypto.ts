// Every hash, MAC, key derivation and signature input in TAIL (TECHNICAL.md 4.1–4.10).
// SHA-256, HMAC-SHA256, HKDF-SHA256, X25519 + ChaCha20-Poly1305, ed25519. The Merkle log is in
// merkle.ts, the referee's signed messages in signed.ts.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Writer } from "./borsh.ts";
import { concat, equal, fixed, readU64le, toHex, u16le, u32le, utf8 } from "./bytes.ts";
import { Domain, EPOCH_MS } from "./constants.ts";
import { type Batch, encodeBatch, encodeVerdictPayload, type VerdictPayload } from "./messages.ts";

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

/**
 * The 32 bytes the referee signs with ed25519 and the contract checks with ed25519_verify:
 * SHA256("tail/verdict/v2" ‖ borsh(match_id, seq, prev, call_id, body)). The next verdict's
 * `prev` is this value.
 */
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

// ── ed25519 ─────────────────────────────────────────────────────────────────────

/**
 * Does `sig` sign `digest` under the ed25519 key `publicKey`? Strict RFC 8032 checks
 * (`zip215: false`), as the Rust side's `verify_strict`. Never throws.
 */
export function verifyEd25519(publicKey: Uint8Array, digest: Uint8Array, sig: Uint8Array): boolean {
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, digest, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

// ── Sealing (phone ↔ enclave) ───────────────────────────────────────────────────

const NONCE = new Uint8Array(12); // Each sealing key is used exactly once (fresh ephemeral key).

const P25519 = 2n ** 255n - 19n;
/**
 * u-coordinates of order dividing 8 on Curve25519 and its twist: 0, 1, p−1 and the two order-8
 * points. Same list as libsodium.
 */
const LOW_ORDER_U = new Set([
  0n,
  1n,
  P25519 - 1n,
  325606250916557431795983626356110631294008115727848805560023387167927233504n,
  39382357235489614581723060781553021112529911719440698176882885853963445705823n,
]);

/**
 * True for an X25519 public key whose shared secret with any private key is all zeros. Such a
 * key would make a "sealed" message readable by anyone. X25519 ignores bit 255 and reduces mod
 * p, so the encodings p and p+1 of 0 and 1 are caught too.
 */
export function isLowOrderX25519(pk: Uint8Array): boolean {
  const b = fixed(pk, 32, "X25519 public key");
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(i === 31 ? (b[i] as number) & 0x7f : (b[i] as number));
  return LOW_ORDER_U.has(u % P25519);
}

function sharedSecret(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  if (isLowOrderX25519(pk)) throw new Error("low-order public key");
  const s = x25519.getSharedSecret(sk, pk);
  // Unreachable once low-order keys are refused; kept so a gap in the list cannot leak.
  if (equal(s, new Uint8Array(32))) throw new Error("all-zero shared secret");
  return s;
}

function sealKey(shared: Uint8Array, ephPk: Uint8Array, recipientPk: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(ephPk, recipientPk), utf8(Domain.seal), 32);
}

/**
 * sealed = eph_pk (32) ‖ ChaCha20-Poly1305(key, nonce 0, plaintext, aad = context).
 * key = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk), salt = eph_pk ‖ recipient_pk, info = "tail/seal/v1").
 * `context` names what is sealed (SealContext) so a ciphertext cannot be replayed as a different
 * kind of message. Throws for a low-order recipient key.
 */
export function sealWith(
  ephSk: Uint8Array,
  recipientPk: Uint8Array,
  plaintext: Uint8Array,
  context: string,
): Uint8Array {
  const ephPk = x25519.getPublicKey(fixed(ephSk, 32, "ephemeral key"));
  const key = sealKey(sharedSecret(ephSk, fixed(recipientPk, 32, "recipient key")), ephPk, recipientPk);
  return concat(ephPk, chacha20poly1305(key, NONCE, utf8(context)).encrypt(plaintext));
}

export const seal = (recipientPk: Uint8Array, plaintext: Uint8Array, context: string) =>
  sealWith(x25519.utils.randomSecretKey(), recipientPk, plaintext, context);

/** Throws if the message is short, its ephemeral key is low-order, or it fails to authenticate. */
export function open(recipientSk: Uint8Array, sealed: Uint8Array, context: string): Uint8Array {
  if (sealed.length < 32 + 16) throw new Error("sealed message too short");
  const ephPk = sealed.slice(0, 32);
  const recipientPk = x25519.getPublicKey(fixed(recipientSk, 32, "recipient key"));
  const key = sealKey(sharedSecret(recipientSk, ephPk), ephPk, recipientPk);
  return chacha20poly1305(key, NONCE, utf8(context)).decrypt(sealed.slice(32));
}

export const boxPublicKey = (sk: Uint8Array) => x25519.getPublicKey(fixed(sk, 32, "box key"));
