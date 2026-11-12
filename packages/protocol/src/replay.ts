// The replay bundle: everything the relay serves for a finished match (GET /replay/:id) and
// everything the replay app needs to re-verify it in the browser. Bytes are base64 (b64) or
// lowercase hex as named. The bundle is untrusted input: the replay recomputes every hash,
// root and signature from it and checks them against NEAR before showing a verified mark.

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
