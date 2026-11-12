// App Attest attestation check (TECHNICAL.md 4.4), following Apple's "Validating apps that
// connect to your server", steps 1–9 of "Verify the attestation". The relay runs it once per
// enrolment; every later message is an assertion the enclave checks against the key returned here.
//
// @peculiar/x509 uses tsyringe, which needs the Reflect metadata polyfill loaded first.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { decode } from "cbor-x";

x509.cryptoProvider.set(crypto);

/**
 * SHA-256 of the DER of Apple's App Attestation Root CA, checked every time the PEM is loaded so
 * a swapped file cannot silently change what we trust. Source:
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 */
export const APPLE_ROOT_SHA256 = "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932";
const APPLE_ROOT_URL = new URL("../apple-app-attest-root-ca.pem", import.meta.url);
/** The credential certificate extension that carries the nonce. */
const NONCE_OID = "1.2.840.113635.100.8.2";

export type Environment = "development" | "production";

const AAGUID: Record<Environment, Uint8Array> = {
  development: new TextEncoder().encode("appattestdevelop"),
  production: new Uint8Array([...new TextEncoder().encode("appattest"), 0, 0, 0, 0, 0, 0, 0]),
};

/** `step` names Apple's numbered check that failed ("root", "decode", "step 1" … "step 9"). */
export class AttestationError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(`${step}: ${message}`);
    this.name = "AttestationError";
  }
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Parses a root certificate and refuses it unless its DER hashes to `expectSha256`. */
export async function loadRoot(pem: string, expectSha256: string): Promise<x509.X509Certificate> {
  const root = new x509.X509Certificate(pem);
  const got = hex(await sha256(new Uint8Array(root.rawData)));
  if (got !== expectSha256)
    throw new AttestationError("root", `pinned root fingerprint mismatch (got ${got})`);
  return root;
}

let appleRoot: Promise<x509.X509Certificate> | undefined;
/** Apple's root, read once from the file next to this package and checked against the pin. */
export function loadAppleRoot(): Promise<x509.X509Certificate> {
  appleRoot ??= Bun.file(APPLE_ROOT_URL)
    .text()
    .then((pem) => loadRoot(pem, APPLE_ROOT_SHA256));
  return appleRoot;
}

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  aaguid: Uint8Array | null;
  credentialId: Uint8Array | null;
}

// WebAuthn authenticator data. Attested credential data (aaguid, credentialId) is present only
// when flag bit 6 (AT) is set, which App Attest sets for attestations.
function parseAuthData(b: Uint8Array): AuthData {
  if (b.length < 37) throw new AttestationError("decode", `authData too short (${b.length} bytes)`);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = b[32] as number;
  const out: AuthData = {
    rpIdHash: b.slice(0, 32),
    flags,
    counter: view.getUint32(33, false),
    aaguid: null,
    credentialId: null,
  };
  if (flags & 0x40) {
    if (b.length < 55) throw new AttestationError("decode", "attested credential data truncated");
    out.aaguid = b.slice(37, 53);
    const len = view.getUint16(53, false);
    if (b.length < 55 + len) throw new AttestationError("decode", "credentialId truncated");
    out.credentialId = b.slice(55, 55 + len);
  }
  return out;
}

// Minimal DER reader for the nonce extension: SEQUENCE { [1] EXPLICIT OCTET STRING }.
function readTlv(b: Uint8Array, at: number): { tag: number; value: Uint8Array; next: number } {
  if (at + 2 > b.length) throw new Error("truncated");
  const tag = b[at] as number;
  let len = b[at + 1] as number;
  let off = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || off + n > b.length) throw new Error("bad length");
    len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | (b[off + k] as number);
    off += n;
  }
  if (off + len > b.length) throw new Error("truncated value");
  return { tag, value: b.subarray(off, off + len), next: off + len };
}

function nonceFromExtension(der: Uint8Array): Uint8Array {
  try {
    const seq = readTlv(der, 0);
    if (seq.tag !== 0x30 || seq.next !== der.length) throw new Error("not a single SEQUENCE");
    const tagged = readTlv(seq.value, 0);
    if (tagged.tag !== 0xa1) throw new Error(`expected [1], got 0x${tagged.tag.toString(16)}`);
    const oct = readTlv(tagged.value, 0);
    if (oct.tag !== 0x04) throw new Error("expected OCTET STRING");
    return oct.value.slice();
  } catch (e) {
    throw new AttestationError("step 4", `nonce extension: ${(e as Error).message}`);
  }
}

export interface AttestationInput {
  /** The CBOR attestation object from `attestKey`. */
  attestation: Uint8Array;
  /** The key identifier from `generateKey`, base64-decoded (32 bytes). */
  keyId: Uint8Array;
  /** The 32-byte hash the app passed to `attestKey`. */
  clientDataHash: Uint8Array;
  /** `<team id>.<bundle id>`. */
  appId: string;
  environment: Environment;
  /** Certificate validity is checked at this time. Defaults to now; tests pin the capture time. */
  now?: Date;
}

/**
 * Verifies an App Attest attestation object and returns the attested device public key, SEC1
 * uncompressed (65 bytes: 0x04 ‖ x ‖ y). Throws `AttestationError` naming the failed step.
 */
export async function verifyAttestation(input: AttestationInput): Promise<Uint8Array> {
  const now = input.now ?? new Date();
  if (input.clientDataHash.length !== 32)
    throw new AttestationError("decode", "clientDataHash must be 32 bytes");
  const root = await loadAppleRoot();

  let obj: { fmt?: unknown; attStmt?: { x5c?: unknown }; authData?: unknown };
  try {
    obj = decode(input.attestation);
  } catch (e) {
    throw new AttestationError("decode", `attestation is not CBOR: ${(e as Error).message}`);
  }
  if (obj?.fmt !== "apple-appattest") throw new AttestationError("decode", "fmt is not apple-appattest");
  const x5c = obj.attStmt?.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2 || !x5c.every((c) => c instanceof Uint8Array)) {
    throw new AttestationError(
      "decode",
      "attStmt.x5c must hold the credential and intermediate certificates",
    );
  }
  if (!(obj.authData instanceof Uint8Array)) throw new AttestationError("decode", "authData missing");
  const authData = new Uint8Array(obj.authData);

  // Step 1: credential cert ← intermediate ← pinned root, each validly signed and in its window.
  let leaf: x509.X509Certificate;
  let inter: x509.X509Certificate;
  try {
    leaf = new x509.X509Certificate(new Uint8Array(x5c[0] as Uint8Array));
    inter = new x509.X509Certificate(new Uint8Array(x5c[1] as Uint8Array));
  } catch (e) {
    throw new AttestationError("step 1", `certificate does not parse: ${(e as Error).message}`);
  }
  for (const [cert, issuer, name] of [
    [leaf, inter, "credential certificate"],
    [inter, root, "intermediate certificate"],
  ] as const) {
    if (cert.issuer !== issuer.subject) throw new AttestationError("step 1", `${name} has the wrong issuer`);
    if (!(await cert.verify({ publicKey: issuer.publicKey, date: now }))) {
      throw new AttestationError("step 1", `${name} is not validly signed at ${now.toISOString()}`);
    }
  }

  // Steps 2–4: the credential certificate commits to nonce = SHA256(authData ‖ clientDataHash).
  const nonce = await sha256(authData, input.clientDataHash);
  const ext = leaf.getExtension(NONCE_OID);
  if (!ext) throw new AttestationError("step 4", "credential certificate has no nonce extension");
  if (!equal(nonceFromExtension(new Uint8Array(ext.value)), nonce)) {
    throw new AttestationError("step 4", "nonce does not match this clientDataHash");
  }

  // Step 5: the key identifier is SHA256 of the credential public key.
  const key = await leaf.publicKey.export({ name: "ECDSA", namedCurve: "P-256" }, ["verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  if (publicKey.length !== 65 || publicKey[0] !== 4)
    throw new AttestationError("step 5", "not a P-256 point");
  if (!equal(await sha256(publicKey), input.keyId)) {
    throw new AttestationError("step 5", "SHA256(public key) is not the keyId");
  }

  // Steps 6–9 on the authenticator data.
  const ad = parseAuthData(authData);
  if (!equal(ad.rpIdHash, await sha256(new TextEncoder().encode(input.appId)))) {
    throw new AttestationError("step 6", `rpIdHash is not SHA256("${input.appId}")`);
  }
  if (ad.counter !== 0) throw new AttestationError("step 7", `counter is ${ad.counter}, expected 0`);
  if (!ad.aaguid || !equal(ad.aaguid, AAGUID[input.environment])) {
    throw new AttestationError("step 8", `aaguid is not the ${input.environment} value`);
  }
  if (!ad.credentialId || !equal(ad.credentialId, input.keyId)) {
    throw new AttestationError("step 9", "credentialId is not the keyId");
  }
  return publicKey;
}
