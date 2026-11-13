// The one place the relay talks to the OutLayer referee (crates/referee-wasi/README.md). Every
// command is `POST {OUTLAYER_API}/call/{owner}/{project}` with `{input: {cmd, …}}`; the referee
// answers `{ok: true, result}` or `{ok: false, error}` inside OutLayer's `output`. Bytes are
// base64 on the wire and Uint8Array here. Each answer is checked field by field, so a shape
// change in the referee fails loudly in this file instead of deep inside the tick loop.
//
// Protocol v2: during play the referee hands the relay only what the relay needs to carry. The
// log comes as RFC 6962 leaf hashes plus one blob per call holding the same entries sealed to the
// referee itself (`log_sealed`), which the relay keeps in order and gives back after End to have
// the log declassified. Hints are opaque blobs sealed to the referee, the Handler's line comes
// sealed and signed for the asker, and every Checkpoint/End verdict comes with the consistency
// proof the contract checks it against.

import { decodeSignedVerdict, RefuseCode, RejectCode, type SignedVerdict } from "@tail/protocol";
import type { Config } from "./config.ts";

export interface Circle {
  latE7: number;
  lonE7: number;
  radiusM: number;
}

export interface RefereeKeys {
  refereePk: Uint8Array;
  refereeBoxPk: Uint8Array;
  boxPkSig: Uint8Array;
  vrfPk: Uint8Array;
}

export interface EnrollInput {
  accountId: string;
  appAttestPk: Uint8Array;
  playerBoxPk: Uint8Array;
  nearPk: Uint8Array;
  /**
   * A phone's CBOR attestation object exactly as it sent it, and the 32-byte challenge the relay
   * issued, so the referee can check the attestation itself. Absent for ghosts (no attestation).
   */
  attestation?: Uint8Array;
  challenge?: Uint8Array;
  /**
   * The phone's consent to replace the referee's existing record for the account: ed25519 by
   * that record's near_pk over SHA256("tail/rebind/v1" ‖ borsh(account_id) ‖ app_attest_pk (65)
   * ‖ player_box_pk ‖ near_pk). The relay passes it through as the phone sent it.
   */
  rebindSig?: Uint8Array;
}
export interface EnrollResult {
  callId: string;
  /** The verdict key that signed the receipt; null when the referee's answer predates the field. */
  refereePk: Uint8Array | null;
  appAttestPk: Uint8Array;
  receipt: Uint8Array;
  sig: Uint8Array;
  /**
   * Whether the referee checked an Apple attestation for this device itself (false: a ghost the
   * referee took unattested). Null when the referee's answer predates the field.
   */
  attested: boolean | null;
}

/** A borsh SignedVerdict as the referee returned it, plus its decoded form. */
export interface RawVerdict {
  raw: Uint8Array;
  v: SignedVerdict;
}

export interface StartInput {
  matchId: Uint8Array;
  players: string[];
  startMs: number;
  stake: bigint;
  durationMs: number;
  zone: Circle;
  safehouses: Circle[];
}
export interface SealedFor {
  player: number;
  sealed: Uint8Array;
}
/**
 * The RFC 9162 consistency proof for one Checkpoint/End verdict: from the log size the contract
 * last anchored for the match (0 for the first) to the verdict's own `log_size`.
 */
export interface VerdictProof {
  seq: number;
  fromSize: number;
  path: Uint8Array[];
}

/** What one referee call appended to the match log. */
export interface LogAppend {
  /** RFC 6962 leaf hash of each new entry, in order. */
  leaves: Uint8Array[];
  /** The same entries (borsh Vec<LogEntry>) sealed to the referee; opaque to the relay. */
  logSealed: Uint8Array;
}

export interface StartResult extends LogAppend {
  callId: string;
  startMs: number;
  /** start_ms + duration_ms. */
  endMs: number;
  verdicts: RawVerdict[];
  /** SignedPlayerKeys sealed to each player's box key. */
  keys: (SealedFor & { accountId: string })[];
  state: Uint8Array;
}

export interface TickInput {
  matchId: Uint8Array;
  state: Uint8Array;
  lastSeq: number;
  batches: Uint8Array[];
  /** The `receipt` blobs of voice answers since the last tick: the referee logs them. */
  receipts: Uint8Array[];
}
/**
 * A hint the referee charged this tick. Everything about it (kind, fact, question) is in `blob`,
 * sealed to the referee; the relay only knows who asked, and hands the blob to `voice`.
 */
export interface HintIssued {
  player: number;
  blob: Uint8Array;
}
/**
 * A batch or action the referee turned down: `reason` is a protocol RejectCode for a batch
 * (`rejected`), a RefuseCode for an action (`refused`).
 */
export type Refusal = Record<string, unknown> & { player: number; reason: number };

const nameOf = (table: Record<string, number>) => {
  const names = new Map(Object.entries(table).map(([name, code]) => [code, name]));
  return (code: number) => names.get(code) ?? `code ${code}`;
};
/** A RejectCode in plain words, for the relay's logs ("TooOld"). */
export const rejectName = nameOf(RejectCode);
/** A RefuseCode in plain words, for the relay's logs ("Cooldown"). */
export const refuseName = nameOf(RefuseCode);
export interface TickResult extends LogAppend {
  callId: string;
  tickNo: number;
  /** The referee time this tick ran at. */
  nowMs: number;
  seq: number;
  state: Uint8Array;
  verdicts: RawVerdict[];
  /** One per Checkpoint/End in `verdicts`. */
  proofs: VerdictProof[];
  /** SignedHud sealed to each player's box key. */
  huds: SealedFor[];
  /** Size and root of the whole match log after this tick, to check the relay's leaves against. */
  logSize: number;
  logRoot: Uint8Array;
  /** Sealed batches that did not open (index into the tick's batches, reason). */
  unopened: Record<string, unknown>[];
  /** Batches the referee did not accept (player, seq, reason). */
  rejected: Refusal[];
  /** Actions in accepted batches that had no effect (player, nonce, reason). */
  refused: Refusal[];
  hints: HintIssued[];
  over: boolean;
}

export interface VoiceInput {
  state: Uint8Array;
  blob: Uint8Array;
}
export interface VoiceResult {
  /** The asker. */
  player: number;
  /** The hint this line answers; public already, in the Hint verdict on chain. */
  hintId: number;
  /**
   * The HintReceipt sealed to the referee, for the next tick (or `end`) to log. Its leaf is not
   * known yet: the entry is salted for the index it lands at.
   */
  receipt: Uint8Array;
  /** SignedVoiceLine sealed to the asker's box key. */
  sealed: Uint8Array;
  /**
   * The exact message the NEAR AI signature covers (`model:sha256(request):sha256(response)`),
   * public material the replay needs to check that signature; null for a template line.
   */
  signedText: string | null;
}

export interface EndInput {
  matchId: Uint8Array;
  state: Uint8Array;
  lastSeq: number;
  receipts: Uint8Array[];
}
export interface EndResult extends LogAppend {
  callId: string;
  verdicts: RawVerdict[];
  proofs: VerdictProof[];
  logSize: number;
  root: Uint8Array;
  state: Uint8Array;
}

export interface DeclassifyResult {
  /** The whole log in plaintext (borsh LogEntry each), in order. */
  log: Uint8Array[];
  /** The rest of the answer as the referee returned it (ring, VRF alpha and signature, …). */
  reveal: Record<string, unknown>;
}

export interface DeclassifyBatchesInput {
  matchId: Uint8Array;
  /** The End state blob (saves the referee a storage read). */
  state: Uint8Array;
  /** At most MAX_DECLASSIFY_BATCHES sealed BatchEnvelopes. */
  sealed: Uint8Array[];
}
export interface DeclassifyBatchesResult {
  /** borsh Batch (no assertion) for each sealed input that opened, in input order. */
  batches: Uint8Array[];
  /**
   * The App Attest assertion each of `batches` arrived with, parallel to it. The referee always
   * returns them; a stand-in referee that has none leaves them out, and the replay then carries
   * no assertions.
   */
  assertions?: Uint8Array[];
  refused: Record<string, unknown>[];
}
/** The referee opens at most this many sealed batches per call. */
export const MAX_DECLASSIFY_BATCHES = 500;

export interface Referee {
  pubkeys(): Promise<RefereeKeys>;
  enroll(i: EnrollInput): Promise<EnrollResult>;
  start(i: StartInput): Promise<StartResult>;
  tick(i: TickInput): Promise<TickResult>;
  voice(i: VoiceInput): Promise<VoiceResult>;
  end(i: EndInput): Promise<EndResult>;
  /**
   * After End: the plaintext log from every `log_sealed` blob of the match, in order, and the
   * reveal (kept as the referee returned it; the replay reads it).
   */
  declassify(matchId: Uint8Array, logSealed: Uint8Array[]): Promise<DeclassifyResult>;
  /** After End: opens the match's stored sealed batches for the replay. */
  declassifyBatches(i: DeclassifyBatchesInput): Promise<DeclassifyBatchesResult>;
}

/**
 * `refused` is true when the referee itself answered `ok: false`: a deterministic refusal that
 * a retry with the same input will repeat. Transport and HTTP failures leave it false.
 */
export class RefereeError extends Error {
  override name = "RefereeError";
  constructor(
    readonly cmd: string,
    message: string,
    readonly refused: boolean,
  ) {
    super(`referee ${cmd}: ${message}`);
  }
}

// ── JSON field readers ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function shape(cmd: string) {
  const fail = (m: string): never => {
    throw new RefereeError(cmd, `unexpected answer: ${m}`, false);
  };
  const obj = (v: unknown, what: string): Obj =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : fail(`${what} is not an object`);
  const arr = (o: Obj, k: string): unknown[] =>
    Array.isArray(o[k]) ? (o[k] as unknown[]) : fail(`${k} is not a list`);
  const str = (o: Obj, k: string): string =>
    typeof o[k] === "string" ? (o[k] as string) : fail(`${k} is not a string`);
  const int = (o: Obj, k: string): number =>
    Number.isSafeInteger(o[k]) ? (o[k] as number) : fail(`${k} is not an integer`);
  const bool = (o: Obj, k: string): boolean =>
    typeof o[k] === "boolean" ? (o[k] as boolean) : fail(`${k} is not a bool`);
  const bytes = (o: Obj, k: string): Uint8Array => b64d(str(o, k));
  const hex = (o: Obj, k: string): Uint8Array => {
    const h = str(o, k);
    return /^([0-9a-f]{2})*$/.test(h) ? new Uint8Array(Buffer.from(h, "hex")) : fail(`${k} is not hex`);
  };
  const bytesList = (o: Obj, k: string): Uint8Array[] =>
    arr(o, k).map((s, i) => (typeof s === "string" ? b64d(s) : fail(`${k}[${i}] is not base64`)));
  const verdicts = (o: Obj, k: string): RawVerdict[] =>
    bytesList(o, k).map((raw) => {
      try {
        return { raw, v: decodeSignedVerdict(raw) };
      } catch (e) {
        return fail(`${k} holds a verdict that does not decode (${(e as Error).message})`);
      }
    });
  const sealedList = (o: Obj, k: string): SealedFor[] =>
    arr(o, k).map((x, i) => {
      const e = obj(x, `${k}[${i}]`);
      return { player: int(e, "player"), sealed: bytes(e, "sealed") };
    });
  const leaves = (o: Obj, k: string): Uint8Array[] =>
    bytesList(o, k).map((h, i) => (h.length === 32 ? h : fail(`${k}[${i}] is not a 32-byte hash`)));
  const appended = (o: Obj): LogAppend => ({
    leaves: leaves(o, "leaves"),
    logSealed: bytes(o, "log_sealed"),
  });
  const proofs = (o: Obj, k: string): VerdictProof[] =>
    arr(o, k).map((x, i) => {
      const e = obj(x, `${k}[${i}]`);
      return { seq: int(e, "seq"), fromSize: int(e, "from_size"), path: leaves(e, "path") };
    });
  const refusals = (o: Obj, k: string): Refusal[] =>
    arr(o, k).map((x, i) => {
      const e = obj(x, `${k}[${i}]`);
      return { ...e, player: int(e, "player"), reason: int(e, "reason") };
    });
  return {
    obj,
    arr,
    str,
    int,
    bool,
    bytes,
    hex,
    bytesList,
    verdicts,
    sealedList,
    appended,
    proofs,
    refusals,
  };
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64d = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const circle = (c: Circle) => ({ lat_e7: c.latE7, lon_e7: c.lonE7, radius_m: c.radiusM });

// ── Transports ───────────────────────────────────────────────────────────────────

/** What one referee command came back with: the referee's own `{ok, result | error}` answer. */
export interface RefereeAnswer {
  answer: unknown;
  /** The OutLayer call id (or the local referee's), for the attestation link and the log. */
  callId: string;
  /** OutLayer compute_cost in micro-USD; 0 for the local referee. */
  cost: number;
}

/** Sends one command. Throws a non-refused RefereeError when no answer came back. */
export type RefereeTransport = (cmd: string, input: Obj) => Promise<RefereeAnswer>;

/** OutLayer over HTTPS: `POST {api}/call/{owner}/{project}` with `{input: {cmd, …}}`. */
export function outLayerTransport(o: RefereeClientOptions): RefereeTransport {
  const url = `${o.api}/call/${o.owner}/${o.project}`;
  const doFetch = o.fetch ?? fetch;
  return async (cmd, input) => {
    const body = JSON.stringify(
      o.version ? { input: { cmd, ...input }, version_key: o.version } : { input: { cmd, ...input } },
    );
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "X-Payment-Key": o.paymentKey, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new RefereeError(cmd, `request failed: ${(e as Error).message}`, false);
    }
    const text = await res.text();
    let j: Obj;
    try {
      j = JSON.parse(text) as Obj;
    } catch {
      // Cloudflare's 524 page lands here when OutLayer's workers do not answer in time.
      const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1];
      throw new RefereeError(
        cmd,
        `HTTP ${res.status}, not JSON${title ? ` (${title})` : `: ${text.slice(0, 200)}`}`,
        false,
      );
    }
    const out = j["output"];
    if (!res.ok || typeof out !== "object" || out === null) {
      throw new RefereeError(cmd, `HTTP ${res.status}: ${text.slice(0, 200)}`, false);
    }
    const cost = Number(j["compute_cost"] ?? 0);
    return {
      answer: out,
      callId: typeof j["call_id"] === "string" ? j["call_id"] : "",
      cost: Number.isFinite(cost) ? cost : 0,
    };
  };
}

export interface LocalRefereeOptions {
  /** The native build of crates/referee-wasi (`tail-referee`). */
  bin: string;
  /** Where the local referee keeps its keys and storage (TAIL_LOCAL_REFEREE_DIR). */
  dir: string;
  /** The account the VRF alpha names as sender, as OutLayer names the project owner. */
  owner: string;
  /**
   * Sets ALLOW_UNATTESTED=1 for the referee process, so it registers ghosts (no Apple
   * attestation). True only when the relay itself allows ghosts (testnet, ALLOW_GHOSTS=1).
   */
  allowUnattested: boolean;
  timeoutMs?: number;
}

/**
 * The local test referee: the same referee code built natively, one process per command, JSON
 * in on stdin and out on stdout (crates/referee-wasi README, "Local test referee"). Not an
 * enclave: its keys are files on this machine. Only for testing while OutLayer is unavailable,
 * against a contract that pins this referee's keys, and every replay it judges says so.
 */
export function localTransport(o: LocalRefereeOptions): RefereeTransport {
  return async (cmd, input) => {
    const proc = Bun.spawn([o.bin], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "",
        TAIL_LOCAL_REFEREE_DIR: o.dir,
        TAIL_LOCAL_REFEREE_OWNER: o.owner,
        ...(o.allowUnattested ? { ALLOW_UNATTESTED: "1" } : {}),
      },
    });
    proc.stdin.write(JSON.stringify({ cmd, ...input }));
    await proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 30_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    let answer: unknown;
    try {
      answer = JSON.parse(out);
    } catch {
      throw new RefereeError(cmd, `local referee exited ${code} without JSON: ${err.slice(0, 200)}`, false);
    }
    const result = (answer as Obj)["result"];
    const callId =
      typeof result === "object" && result !== null && typeof (result as Obj)["call_id"] === "string"
        ? ((result as Obj)["call_id"] as string)
        : "";
    return { answer, callId, cost: 0 };
  };
}

// ── Client ───────────────────────────────────────────────────────────────────────

export interface RefereeClientOptions {
  api: string;
  owner: string;
  project: string;
  paymentKey: string;
  /** Pins a deployed wasm sha256 instead of the active version. */
  version?: string | undefined;
  /** Per-call deadline; OutLayer's own cap is 180 s, p95 measured at ~10 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CallStat {
  cmd: string;
  callId: string;
  wallMs: number;
  /** OutLayer compute_cost, in micro-USD. */
  cost: number;
}

/** The referee's commands over a transport. Keeps a record of every call for timings and spend. */
export class RefereeClient implements Referee {
  readonly calls: CallStat[] = [];

  constructor(private readonly send: RefereeTransport) {}

  /** Total spend so far, from OutLayer's compute_cost (micro-USD). */
  spendUsd(): number {
    return this.calls.reduce((s, c) => s + c.cost, 0) / 1e6;
  }

  private async call(cmd: string, args: Obj): Promise<Obj> {
    const t0 = performance.now();
    const { answer, callId, cost } = await this.send(cmd, args);
    this.calls.push({ cmd, callId, wallMs: performance.now() - t0, cost });
    if (typeof answer !== "object" || answer === null)
      throw new RefereeError(cmd, "answer is not an object", false);
    const o = answer as Obj;
    if (o["ok"] === false) throw new RefereeError(cmd, String(o["error"]), true);
    if (o["ok"] !== true) throw new RefereeError(cmd, "answer has no ok field", false);
    return shape(cmd).obj(o["result"], "result");
  }

  async pubkeys(): Promise<RefereeKeys> {
    const r = await this.call("pubkeys", {});
    const s = shape("pubkeys");
    return {
      refereePk: s.bytes(r, "referee_pk"),
      refereeBoxPk: s.bytes(r, "referee_box_pk"),
      boxPkSig: s.bytes(r, "box_pk_sig"),
      vrfPk: s.hex(r, "vrf_pk"),
    };
  }

  async enroll(i: EnrollInput): Promise<EnrollResult> {
    const r = await this.call("enroll", {
      account_id: i.accountId,
      app_attest_pk: b64(i.appAttestPk),
      player_box_pk: b64(i.playerBoxPk),
      near_pk: b64(i.nearPk),
      ...(i.attestation && i.challenge
        ? { attestation: b64(i.attestation), challenge: b64(i.challenge) }
        : {}),
      ...(i.rebindSig ? { rebind_sig: b64(i.rebindSig) } : {}),
    });
    const s = shape("enroll");
    if (s.str(r, "account_id") !== i.accountId)
      throw new RefereeError("enroll", "enrolled another account", false);
    return {
      callId: s.str(r, "call_id"),
      refereePk: r["referee_pk"] === undefined ? null : s.bytes(r, "referee_pk"),
      appAttestPk: s.bytes(r, "app_attest_pk"),
      receipt: s.bytes(r, "receipt"),
      sig: s.bytes(r, "sig"),
      attested: r["attested"] === undefined ? null : s.bool(r, "attested"),
    };
  }

  async start(i: StartInput): Promise<StartResult> {
    const r = await this.call("start", {
      match_id: b64(i.matchId),
      players: i.players,
      start_ms: i.startMs,
      duration_ms: i.durationMs,
      stake: i.stake.toString(),
      zone: circle(i.zone),
      safehouses: i.safehouses.map(circle),
    });
    const s = shape("start");
    return {
      callId: s.str(r, "call_id"),
      startMs: s.int(r, "start_ms"),
      endMs: s.int(r, "end_ms"),
      verdicts: s.verdicts(r, "verdicts"),
      keys: s.arr(r, "keys").map((x, k) => {
        const e = s.obj(x, `keys[${k}]`);
        return {
          player: s.int(e, "player"),
          accountId: s.str(e, "account_id"),
          sealed: s.bytes(e, "sealed"),
        };
      }),
      state: s.bytes(r, "state"),
      ...s.appended(r),
    };
  }

  async tick(i: TickInput): Promise<TickResult> {
    const r = await this.call("tick", {
      match_id: b64(i.matchId),
      state: b64(i.state),
      last_seq: i.lastSeq,
      batches: i.batches.map(b64),
      receipts: i.receipts.map(b64),
    });
    const s = shape("tick");
    return {
      callId: s.str(r, "call_id"),
      tickNo: s.int(r, "tick_no"),
      nowMs: s.int(r, "now_ms"),
      seq: s.int(r, "seq"),
      state: s.bytes(r, "state"),
      verdicts: s.verdicts(r, "verdicts"),
      proofs: s.proofs(r, "proofs"),
      huds: s.sealedList(r, "huds"),
      ...s.appended(r),
      logSize: s.int(r, "log_size"),
      logRoot: s.hex(r, "log_root"),
      unopened: s.arr(r, "unopened").map((x, k) => s.obj(x, `unopened[${k}]`)),
      rejected: s.refusals(r, "rejected"),
      refused: s.refusals(r, "refused"),
      hints: s.arr(r, "hints").map((x, k) => {
        const h = s.obj(x, `hints[${k}]`);
        return { player: s.int(h, "player"), blob: s.bytes(h, "blob") };
      }),
      over: s.bool(r, "over"),
    };
  }

  async voice(i: VoiceInput): Promise<VoiceResult> {
    const r = await this.call("voice", { state: b64(i.state), blob: b64(i.blob) });
    const s = shape("voice");
    const text = r["signed_text"];
    return {
      player: s.int(r, "player"),
      sealed: s.bytes(r, "sealed"),
      signedText: text === null ? null : s.str(r, "signed_text"),
      hintId: s.int(r, "hint_id"),
      receipt: s.bytes(r, "receipt"),
    };
  }

  async end(i: EndInput): Promise<EndResult> {
    const r = await this.call("end", {
      match_id: b64(i.matchId),
      state: b64(i.state),
      last_seq: i.lastSeq,
      receipts: i.receipts.map(b64),
    });
    const s = shape("end");
    return {
      callId: s.str(r, "call_id"),
      verdicts: s.verdicts(r, "verdicts"),
      proofs: s.proofs(r, "proofs"),
      logSize: s.int(r, "log_size"),
      root: s.hex(r, "root"),
      state: s.bytes(r, "state"),
      ...s.appended(r),
    };
  }

  async declassify(matchId: Uint8Array, logSealed: Uint8Array[]): Promise<DeclassifyResult> {
    const r = await this.call("declassify", { match_id: b64(matchId), log_sealed: logSealed.map(b64) });
    const { log: _log, ...reveal } = r;
    return { log: shape("declassify").bytesList(r, "log"), reveal };
  }

  async declassifyBatches(i: DeclassifyBatchesInput): Promise<DeclassifyBatchesResult> {
    if (i.sealed.length > MAX_DECLASSIFY_BATCHES) {
      throw new RefereeError("declassify_batches", `at most ${MAX_DECLASSIFY_BATCHES} per call`, true);
    }
    const r = await this.call("declassify_batches", {
      match_id: b64(i.matchId),
      state: b64(i.state),
      sealed: i.sealed.map(b64),
    });
    const s = shape("declassify_batches");
    const batches = s.bytesList(r, "batches");
    const assertions = s.bytesList(r, "assertions");
    if (assertions.length !== batches.length)
      throw new RefereeError(
        "declassify_batches",
        `unexpected answer: ${assertions.length} assertions for ${batches.length} batches`,
        false,
      );
    return {
      batches,
      assertions,
      refused: s.arr(r, "refused").map((x, k) => s.obj(x, `refused[${k}]`)),
    };
  }
}

/** The referee on OutLayer (the enclave): the default, and the only one a real match should use. */
export class OutLayerReferee extends RefereeClient {
  constructor(o: RefereeClientOptions) {
    super(outLayerTransport(o));
  }
}

/** The local test referee (see localTransport). */
export class LocalReferee extends RefereeClient {
  constructor(o: LocalRefereeOptions) {
    super(localTransport(o));
  }
}

/** The referee this config asks for: OutLayer's enclave by default, the local test referee in local mode. */
export function makeReferee(c: Config): RefereeClient {
  if (c.refereeMode === "local" && c.localReferee) {
    return new LocalReferee({ ...c.localReferee, owner: c.relayAccount, allowUnattested: c.allowGhosts });
  }
  return new OutLayerReferee({
    api: c.outlayerApi,
    owner: c.outlayerOwner,
    project: c.refereeProject,
    paymentKey: c.refereePaymentKey,
    version: c.refereeVersion,
  });
}

// ── Health ───────────────────────────────────────────────────────────────────────

export type RefereeKind = "outlayer" | "local";

export interface RefereeHealth {
  kind: RefereeKind;
  /** unknown until the first answer; down after DOWN_AFTER transport failures in a row. */
  status: "unknown" | "up" | "down";
  lastOkMs: number | null;
  lastError: string | null;
}

/** Thrown without calling the referee while it is known to be down. */
export class RefereeUnavailableError extends RefereeError {
  override name = "RefereeUnavailableError";
}

/** Transport failures in a row that mark the referee down. */
const DOWN_AFTER = 2;
/** While down, one call is let through this often to see whether it is back. */
export const PROBE_MS = 30_000;

/**
 * Wraps a referee so the relay knows whether it is answering. While it is down, calls fail at
 * once instead of each waiting out the transport's deadline, and one call every PROBE_MS goes
 * through to find out when it is back. A refusal is an answer: it counts as up.
 */
export class GuardedReferee implements Referee {
  private status: RefereeHealth["status"] = "unknown";
  private failures = 0;
  private lastOkMs: number | null = null;
  private lastError: string | null = null;
  private lastAttemptMs = 0;
  private probing = false;
  private readonly now: () => number;

  constructor(
    private readonly inner: Referee,
    readonly kind: RefereeKind,
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  health(): RefereeHealth {
    return { kind: this.kind, status: this.status, lastOkMs: this.lastOkMs, lastError: this.lastError };
  }

  private async run<T>(cmd: string, f: () => Promise<T>): Promise<T> {
    const now = this.now();
    let probe = false;
    if (this.status === "down") {
      if (this.probing || now - this.lastAttemptMs < PROBE_MS) {
        throw new RefereeUnavailableError(cmd, `not answering (${this.lastError ?? "no answer"})`, false);
      }
      probe = true;
      this.probing = true;
    }
    this.lastAttemptMs = now;
    try {
      const r = await f();
      this.answered();
      return r;
    } catch (e) {
      if (e instanceof RefereeError && e.refused) this.answered();
      else {
        this.failures += 1;
        this.lastError = (e as Error).message;
        if (this.failures >= DOWN_AFTER) this.status = "down";
      }
      throw e;
    } finally {
      if (probe) this.probing = false;
    }
  }

  private answered() {
    this.status = "up";
    this.failures = 0;
    this.lastOkMs = this.now();
  }

  pubkeys() {
    return this.run("pubkeys", () => this.inner.pubkeys());
  }
  enroll(i: EnrollInput) {
    return this.run("enroll", () => this.inner.enroll(i));
  }
  start(i: StartInput) {
    return this.run("start", () => this.inner.start(i));
  }
  tick(i: TickInput) {
    return this.run("tick", () => this.inner.tick(i));
  }
  voice(i: VoiceInput) {
    return this.run("voice", () => this.inner.voice(i));
  }
  end(i: EndInput) {
    return this.run("end", () => this.inner.end(i));
  }
  declassify(matchId: Uint8Array, logSealed: Uint8Array[]) {
    return this.run("declassify", () => this.inner.declassify(matchId, logSealed));
  }
  declassifyBatches(i: DeclassifyBatchesInput) {
    return this.run("declassify_batches", () => this.inner.declassifyBatches(i));
  }
}
