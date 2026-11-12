// A ghost player: a simulated phone that talks to the relay exactly as the app does, over HTTP
// and the HUD WebSocket. It has the three keys a phone has (a NEAR function-call key, an X25519
// box key, a P-256 App Attest-style key), builds real batches with real beacon tokens, chains
// them, asserts them (assertion.ts) and seals them to the referee. The only thing it skips is
// Apple's attestation at enrolment (the testing door, routes/dev.ts).

import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import {
  type Action,
  type Batch,
  batchClientDataHash,
  batchHash,
  beaconToken,
  boxPublicKey,
  concat,
  decodeHud,
  decodePlayerKeys,
  encodeBatchEnvelope,
  epochAt,
  type Fix,
  type Hud,
  open,
  type PlayerKeys,
  type Sighting,
  seal,
  tagMatches,
  toHex,
} from "@tail/protocol";
import { Account, baseEncode, type JsonRpcProvider, type KeyPairString, teraToGas } from "near-api-js";
import { hudDigest, signRequestHeaders } from "../auth.ts";
import { signAssertion } from "./assertion.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export class Ghost {
  readonly nearSeed = ed25519.utils.randomSecretKey();
  readonly nearPk = ed25519.getPublicKey(this.nearSeed);
  readonly boxSk = crypto.getRandomValues(new Uint8Array(32));
  readonly attestSk = p256.utils.randomSecretKey();
  accountId = "";
  keys: PlayerKeys | undefined;
  huds: Hud[] = [];
  handlerLines: string[] = [];
  rejections: Record<string, unknown>[] = [];
  out = false;
  private seq = 0;
  private prev: Uint8Array = new Uint8Array(32);
  private counter = 0;
  private nonce = 0;
  private fixes: Fix[] = [];
  private heard = new Map<string, { epoch: number; token: Uint8Array; rssi: number[] }>();
  private actions: Action[] = [];
  private ws: WebSocket | undefined;

  constructor(
    readonly handle: string,
    private readonly relayUrl: string,
  ) {}

  /** The key in near-api-js form (seed ‖ public key, base58), for the ghost's own transactions. */
  nearKeyString(): KeyPairString {
    return `ed25519:${baseEncode(concat(this.nearSeed, this.nearPk))}` as KeyPairString;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const bytes = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.accountId)
      Object.assign(headers, signRequestHeaders(this.accountId, this.nearSeed, method, path, bytes));
    const res = await fetch(`${this.relayUrl}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: bytes }),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? ""}`);
    return json;
  }

  async enroll() {
    const r = await this.request<{ account_id: string }>("POST", "/dev/ghosts/enroll", {
      handle: this.handle,
      app_attest_pk: b64(p256.getPublicKey(this.attestSk, false)),
      player_box_pk: b64(boxPublicKey(this.boxSk)),
      near_pk: b64(this.nearPk),
    });
    this.accountId = r.account_id;
    return r;
  }

  /** Joins the lobby on chain with the ghost's own function-call key, as a phone does. */
  async join(provider: JsonRpcProvider, contract: string, matchId: string) {
    const acct = new Account(this.accountId, provider, this.nearKeyString());
    await acct.callFunction({
      contractId: contract,
      methodName: "join_match",
      args: { match_id: matchId },
      gas: teraToGas("30"),
    });
  }

  /** Opens the HUD socket and authenticates with the NEAR key. Resolves once the relay says ready. */
  connectHud(matchId: string): Promise<void> {
    const url = `${this.relayUrl.replace(/^http/, "ws")}/hud?match_id=${matchId}&account_id=${this.accountId}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (m["type"] === "challenge") {
          const digest = hudDigest(
            unb64(String(m["nonce"])),
            Uint8Array.from(Buffer.from(matchId, "hex")),
            this.accountId,
          );
          ws.send(JSON.stringify({ type: "auth", sig: b64(ed25519.sign(digest, this.nearSeed)) }));
        } else if (m["type"] === "ready") resolve();
        else if (m["type"] === "keys")
          this.keys = decodePlayerKeys(open(this.boxSk, unb64(String(m["sealed"])), "tail/keys"));
        else if (m["type"] === "hud") {
          const hud = decodeHud(open(this.boxSk, unb64(String(m["sealed"])), "tail/hud"));
          if (hud.tick > (this.huds.at(-1)?.tick ?? 0)) this.huds.push(hud);
          if (hud.status === 1) this.out = true;
        } else if (m["type"] === "handler") this.handlerLines.push(String(m["text"]));
        else if (m["type"] === "rejected") this.rejections.push(m);
      };
      ws.onclose = (ev) => reject(new Error(`HUD socket closed: ${ev.code} ${ev.reason}`));
      ws.onerror = () => reject(new Error("HUD socket error"));
    });
  }

  closeHud() {
    this.ws?.close();
  }

  setKeys(sealed: string) {
    this.keys = decodePlayerKeys(open(this.boxSk, unb64(sealed), "tail/keys"));
  }

  private mustKeys(): PlayerKeys {
    if (!this.keys) throw new Error(`${this.handle} has no PlayerKeys yet`);
    return this.keys;
  }

  token(nowMs: number): Uint8Array {
    const k = this.mustKeys();
    return beaconToken(k.kTag, k.kPlayer, epochAt(nowMs, Number(k.startMs)));
  }

  /** One GPS fix (about 1 Hz). */
  fix(f: Fix) {
    this.fixes.push(f);
  }

  /** An honest scan: only tokens whose tag is from this match for e−1..e+1 are kept. */
  hear(nowMs: number, token: Uint8Array, rssi: number) {
    const k = this.mustKeys();
    const epoch = epochAt(nowMs, Number(k.startMs));
    if (!tagMatches(k.kTag, token, epoch)) return;
    const key = `${epoch}:${toHex(token)}`;
    const h = this.heard.get(key) ?? { epoch, token, rssi: [] };
    h.rssi.push(rssi);
    this.heard.set(key, h);
  }

  hint(kind: number, text?: string) {
    this.actions.push(
      text
        ? { kind: "Hint", hint: kind, nonce: ++this.nonce, text }
        : { kind: "Hint", hint: kind, nonce: ++this.nonce },
    );
  }

  strike() {
    this.actions.push({ kind: "Strike", nonce: ++this.nonce });
  }

  /** Builds, chains, asserts and seals the next batch from everything since the last one. */
  sealedBatch(nowMs: number, refereeBoxPk: Uint8Array, appId: string): Uint8Array {
    const k = this.mustKeys();
    const sightings: Sighting[] = [...this.heard.values()].map((h) => {
      const r = [...h.rssi].sort((a, b) => a - b);
      return {
        epoch: h.epoch,
        token: h.token,
        rssiMax: r[r.length - 1] as number,
        rssiMed: r[Math.floor(r.length / 2)] as number,
        n: Math.min(255, r.length),
      };
    });
    const batch: Batch = {
      matchId: k.matchId,
      player: k.player,
      seq: this.seq,
      prev: this.prev,
      tMs: BigInt(nowMs),
      fixes: this.fixes,
      sightings,
      actions: this.actions,
    };
    this.fixes = [];
    this.heard.clear();
    this.actions = [];
    this.counter++;
    const assertion = signAssertion(this.attestSk, batchClientDataHash(batch), appId, this.counter);
    this.seq++;
    this.prev = batchHash(batch);
    return seal(refereeBoxPk, encodeBatchEnvelope({ batch, assertion }), "tail/batch");
  }
}
