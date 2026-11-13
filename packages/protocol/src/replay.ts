// The replay bundle: everything the relay serves for a finished match (GET /replay/:id) and
// everything the replay app needs to re-verify it in the browser. Bytes are base64 (b64) or
// lowercase hex as named. The bundle is untrusted input: the replay recomputes every hash,
// root and signature from it and checks them against NEAR before showing a verified mark.
//
// Two versions are served. `ReplayBundle` (version 1) is a match judged before protocol v2: the
// relay held the plaintext log during play. `ReplayBundleV2` is a match judged under protocol v2:
// during play the relay held only leaf hashes and log entries sealed to the referee, and the
// plaintext log exists only after End, when the referee declassified it. The relay keeps serving
// a v1 match's bundle as it was.

export interface ReplayCircle {
  latE7: number;
  lonE7: number;
  radiusM: number;
}

export interface ReplayBundle {
  version: 1;
  match: {
    /** 16-byte match id, lowercase hex. */
    id: string;
    contract: string;
    network: "testnet" | "mainnet";
    token: string;
    /** u128 decimal string, token minimal units. */
    stake: string;
    startMs: number;
    endMs: number;
    zone: ReplayCircle;
    safehouses: ReplayCircle[];
    publicReplay: boolean;
    /** Account ids sorted by UTF-8 bytes; index = player number in every message. */
    players: string[];
  };
  referee: {
    /** OutLayer project `owner/name`. */
    project: string;
    /** OutLayer HTTPS API base, for attestation records (`/attestations/by-call/{id}`). */
    api: string;
    /** ed25519 verdict key, hex. */
    refereePk: string;
    /** OutLayer VRF key, hex. */
    vrfPk: string;
    /**
     * Which referee judged. `local` is the test referee run on the relay's machine (not an
     * enclave), used while OutLayer is unavailable; absent means OutLayer, as before this field.
     */
    kind?: "outlayer" | "local";
  };
  /** Every signed verdict in seq order, with the NEAR transaction that applied it. */
  verdicts: { signed: string; txHash: string | null }[];
  /** Every log entry in order (b64 borsh LogEntry). Its Merkle root must match the chain. */
  log: string[];
  /**
   * Declassified batches (b64 borsh Batch), released by the referee after End. Each one's
   * SHA256 must appear as a LogEntry::Batch for its player and seq. Empty when trails were
   * not released.
   */
  batches: string[];
  /** The ring reveal from End. */
  reveal: { vrfAlpha: string; vrfSignature: string; ring: string[] };
  /** Handler lines, matched to LogEntry::HintReceipt by hintId and SHA256(text). */
  handler: { hintId: number; text: string; chatId: string; model: string }[];
}

export const REPLAY_VERSION = 1 as const;

/** Per player, in index order: what kind of device it was and whether the referee checked its attestation. */
export interface ReplayDevice {
  accountId: string;
  /** `ghost`: a simulated test player (testnet only). Null when the relay has no record. */
  kind: "phone" | "ghost" | null;
  /**
   * What the referee said when it registered the device: true it checked an Apple attestation,
   * false it took the device unattested (a ghost). Null when not recorded. The relay's word only:
   * the `Enrolled` log entries carry the referee's own record, under the anchored root.
   */
  attested: boolean | null;
}

export interface ReplayBundleV2 {
  version: 2;
  match: ReplayBundle["match"] & {
    /**
     * The App ID (`TEAMID.bundle`) the referee checked this match's assertions against. Absent in
     * bundles from relays before it was recorded.
     */
    appId?: string;
  };
  referee: ReplayBundle["referee"];
  /** Every signed verdict (protocol v2, chained by `prev`) in seq order, with its NEAR transaction. */
  verdicts: { signed: string; txHash: string | null }[];
  /**
   * The RFC 6962 leaf hash of every log entry, lowercase hex, in order: what the relay held
   * during play and served inclusion and consistency proofs from. `leaves[i]` must equal
   * `merkleLeaf(log[i])`.
   */
  leaves: string[];
  /**
   * Every log entry in order (b64 borsh LogEntry), declassified by the referee after End. Its
   * Merkle root at each anchored size must match the chain.
   */
  log: string[];
  /** As in version 1: declassified batches (b64 borsh Batch), each one a logged `Batch` entry. */
  batches: string[];
  /**
   * The App Attest assertion (b64 CBOR) each of `batches` arrived with, parallel to it, as
   * `declassify_batches` returns them, so a verifier can run the referee's assertion check again
   * (crates/referee-verify). Public-key signatures, not secrets. Absent in older bundles.
   */
  assertions?: string[];
  /**
   * The batches the referee refused (a `LogEntry::Rejected` names each one's SHA256), with the
   * assertion each arrived with, so a verifier can recompute the refusal. Kept apart from
   * `batches`, which are trails: a refused batch is not part of a player's path. An envelope
   * whose batch and assertion are already in `batches` (a plain resend) is not repeated. Absent
   * in older bundles.
   */
  rejected?: { batch: string; assertion: string }[];
  /**
   * The ring reveal from End, and `kM`: the match key K_m (hex), which the referee releases with
   * the log. K_log = HKDF(K_m, "tail/log") gives every salted entry's salt (badLogSalts).
   */
  reveal: ReplayBundle["reveal"] & { kM: string };
  devices: (ReplayDevice & {
    /**
     * The device's App Attest public key as the referee enrolled it (declassify), uncompressed
     * SEC1 P-256, 65 bytes, hex. Its SHA256 is the `Enrolled` entry's key hash. Its assertion
     * counter started at 0. Absent in older bundles.
     */
    appAttestPk?: string;
  })[];
  /**
   * Hints the Handler answered. The words were sealed to the asker, so the relay never had them;
   * what is public is `signedText`, the message the NEAR AI signature covers
   * (`model:sha256(request):sha256(response)`), or null for a template line. The `HintReceipt`
   * log entry with this `hintId` holds the signature, the signing address and SHA256(text).
   */
  handler: { hintId: number; signedText: string | null }[];
}

export const REPLAY_VERSION_V2 = 2 as const;

/** What GET /replay/:id returns: version 1 for matches before protocol v2, version 2 after. */
export type AnyReplayBundle = ReplayBundle | ReplayBundleV2;
