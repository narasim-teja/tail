// The one place the relay talks to the OutLayer referee (crates/referee-wasi/README.md). Every
// command is `POST {OUTLAYER_API}/call/{owner}/{project}` with `{input: {cmd, …}}`; the referee
// answers `{ok: true, result}` or `{ok: false, error}` inside OutLayer's `output`. Bytes are
// base64 on the wire and Uint8Array here. Each answer is checked field by field, so a shape
// change in the referee fails loudly in this file instead of deep inside the tick loop.

import { decodeSignedVerdict, type SignedVerdict } from "@tail/protocol";

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
}
export interface EnrollResult {
  callId: string;
  appAttestPk: Uint8Array;
  receipt: Uint8Array;
  sig: Uint8Array;
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
  appId: string;
}
export interface SealedFor {
  player: number;
  sealed: Uint8Array;
}
export interface StartResult {
  callId: string;
  startMs: number;
  /** start_ms + duration_ms. */
  endMs: number;
  verdicts: RawVerdict[];
  keys: (SealedFor & { accountId: string })[];
  state: Uint8Array;
  log: Uint8Array[];
}

export interface TickInput {
  matchId: Uint8Array;
  state: Uint8Array;
  lastSeq: number;
  batches: Uint8Array[];
  receipts: Uint8Array[];
}
/** A hint the referee charged this tick; `voice` turns it into a Handler line. */
export interface HintIssued {
  hintId: number;
  from: number;
  to: number;
  hint: number;
  value: number;
  text?: string;
}
export interface TickResult {
  callId: string;
  tickNo: number;
  /** The referee time this tick ran at. */
  nowMs: number;
  seq: number;
  state: Uint8Array;
  verdicts: RawVerdict[];
  huds: SealedFor[];
  log: Uint8Array[];
  /** Size and root of the whole match log after this tick, to check the relay's copy against. */
  logSize: number;
  logRoot: Uint8Array;
  /** Sealed batches that did not open (index into the tick's batches, reason). */
  unopened: Record<string, unknown>[];
  /** Batches the referee did not accept, as it reports them (player, seq, reason). */
  rejected: Record<string, unknown>[];
  /** Actions in accepted batches that had no effect (player, nonce, reason). */
  refused: Record<string, unknown>[];
  hints: HintIssued[];
  over: boolean;
}

export interface VoiceInput {
  hintId: number;
  hint: number;
  value: number;
  question?: string;
}
export interface VoiceResult {
  text: string;
  source: string;
  /** borsh HintReceipt for the next tick. */
  receipt: Uint8Array | undefined;
  /** NEAR AI Cloud chat id and model; null for a template line. */
  chatId: string | null;
  model: string | null;
}

export interface EndInput {
  matchId: Uint8Array;
  state: Uint8Array;
  lastSeq: number;
  receipts: Uint8Array[];
}
export interface EndResult {
  callId: string;
  verdicts: RawVerdict[];
  logSize: number;
  root: Uint8Array;
  state: Uint8Array;
  log: Uint8Array[];
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
  /** The plaintext reveal after End, kept as the referee returned it (the replay reads it). */
  declassify(matchId: Uint8Array): Promise<Record<string, unknown>>;
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
  return { obj, arr, str, int, bool, bytes, hex, bytesList, verdicts, sealedList };
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64d = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const circle = (c: Circle) => ({ lat_e7: c.latE7, lon_e7: c.lonE7, radius_m: c.radiusM });

// ── HTTPS client ───────────────────────────────────────────────────────────────────

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

/** The referee over OutLayer HTTPS. Keeps a record of every call for timings and spend. */
export class OutLayerReferee implements Referee {
  readonly calls: CallStat[] = [];
  private readonly url: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly o: RefereeClientOptions) {
    this.url = `${o.api}/call/${o.owner}/${o.project}`;
    this.fetch = o.fetch ?? fetch;
  }

  /** Total spend so far, from OutLayer's compute_cost (micro-USD). */
  spendUsd(): number {
    return this.calls.reduce((s, c) => s + c.cost, 0) / 1e6;
  }

  private async call(cmd: string, args: Obj): Promise<Obj> {
    const t0 = performance.now();
    const body = JSON.stringify(
      this.o.version ? { input: { cmd, ...args }, version_key: this.o.version } : { input: { cmd, ...args } },
    );
    let res: Response;
    try {
      res = await this.fetch(this.url, {
        method: "POST",
        headers: { "X-Payment-Key": this.o.paymentKey, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new RefereeError(cmd, `request failed: ${(e as Error).message}`, false);
    }
    const text = await res.text();
    let j: Obj;
    try {
      j = JSON.parse(text) as Obj;
    } catch {
      throw new RefereeError(cmd, `HTTP ${res.status}, not JSON: ${text.slice(0, 200)}`, false);
    }
    const cost = Number(j["compute_cost"] ?? 0);
    const callId = typeof j["call_id"] === "string" ? j["call_id"] : "";
    this.calls.push({ cmd, callId, wallMs: performance.now() - t0, cost: Number.isFinite(cost) ? cost : 0 });
    const out = j["output"];
    if (!res.ok || typeof out !== "object" || out === null) {
      throw new RefereeError(cmd, `HTTP ${res.status}: ${text.slice(0, 200)}`, false);
    }
    const o = out as Obj;
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
    });
    const s = shape("enroll");
    if (s.str(r, "account_id") !== i.accountId)
      throw new RefereeError("enroll", "enrolled another account", false);
    return {
      callId: s.str(r, "call_id"),
      appAttestPk: s.bytes(r, "app_attest_pk"),
      receipt: s.bytes(r, "receipt"),
      sig: s.bytes(r, "sig"),
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
      app_id: i.appId,
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
      log: s.bytesList(r, "log"),
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
      huds: s.sealedList(r, "huds"),
      log: s.bytesList(r, "log"),
      logSize: s.int(r, "log_size"),
      logRoot: s.hex(r, "log_root"),
      unopened: s.arr(r, "unopened").map((x, k) => s.obj(x, `unopened[${k}]`)),
      rejected: s.arr(r, "rejected").map((x, k) => s.obj(x, `rejected[${k}]`)),
      refused: s.arr(r, "refused").map((x, k) => s.obj(x, `refused[${k}]`)),
      hints: s.arr(r, "hints").map((x, k) => {
        const h = s.obj(x, `hints[${k}]`);
        const text = h["text"];
        return {
          hintId: s.int(h, "hint_id"),
          from: s.int(h, "from"),
          to: s.int(h, "to"),
          hint: s.int(h, "hint"),
          value: s.int(h, "value"),
          ...(typeof text === "string" ? { text } : {}),
        };
      }),
      over: s.bool(r, "over"),
    };
  }

  async voice(i: VoiceInput): Promise<VoiceResult> {
    const r = await this.call("voice", {
      hint: i.hint,
      value: i.value,
      hint_id: i.hintId,
      ...(i.question ? { question: i.question } : {}),
    });
    const s = shape("voice");
    const receipt = r["receipt"];
    return {
      text: s.str(r, "text"),
      source: s.str(r, "source"),
      receipt: typeof receipt === "string" ? b64d(receipt) : undefined,
      chatId: typeof r["chat_id"] === "string" ? r["chat_id"] : null,
      model: typeof r["model"] === "string" ? r["model"] : null,
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
      logSize: s.int(r, "log_size"),
      root: s.hex(r, "root"),
      state: s.bytes(r, "state"),
      log: s.bytesList(r, "log"),
    };
  }

  async declassify(matchId: Uint8Array): Promise<Record<string, unknown>> {
    return this.call("declassify", { match_id: b64(matchId) });
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
    return {
      batches: s.bytesList(r, "batches"),
      refused: s.arr(r, "refused").map((x, k) => s.obj(x, `refused[${k}]`)),
    };
  }
}
