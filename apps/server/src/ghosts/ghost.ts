// A ghost player: a simulated phone that talks to the relay exactly as the app does, over HTTP
// and the HUD WebSocket. It has the three keys a phone has (a NEAR function-call key, an X25519
// box key, a P-256 App Attest-style key), builds real batches with real beacon tokens, chains
// them, asserts them (assertion.ts) and seals them to the referee. It checks the referee's
// signature on everything sealed to it (keys, HUDs, Handler lines), and can hand a signed request
// to the mesh as a carry envelope. The only thing it skips is Apple's attestation at enrolment
// (the testing door): it enrols in-process, through the relay's own Enrolment, because no HTTP
// route enrols a device without an attestation.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  type Action,
  type Batch,
  batchClientDataHash,
  batchHash,
  beaconToken,
  encodeBatchEnvelope,
  epochAt,
  type Fix,
  type Hud,
  openSignedHud,
  openSignedPlayerKeys,
  openSignedVoiceLine,
  type PlayerKeys,
  SealContext,
  type Sighting,
  seal,
  sealCarry,
  tagMatches,
  toHex,
} from "@tail/protocol";
import type { JsonRpcProvider } from "near-api-js";
import { hudDigest, signRequest, signRequestHeaders } from "../auth.ts";
import type { Enrolment } from "../enroll.ts";
import { joinMatchWithKey } from "../near.ts";
import { signAssertion } from "./assertion.ts";
import { newGhostKeys } from "./keys.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** What a phone pins before it talks to a relay: the contract it plays on and that contract's referee key. */
export interface GhostTrust {
  contract: string;
  refereePk: Uint8Array;
}

export class Ghost {
  private readonly k = newGhostKeys();
  readonly nearSeed = this.k.nearSeed;
  readonly boxSk = this.k.boxSk;
  readonly attestSk = this.k.attestSk;
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
    private readonly trust: GhostTrust,
  ) {}

  private signed(method: string, path: string, bytes: Uint8Array) {
    return { contractId: this.trust.contract, accountId: this.accountId, method, path, body: bytes };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const bytes = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.accountId)
      Object.assign(headers, signRequestHeaders(this.signed(method, path, bytes), this.nearSeed));
    const res = await fetch(`${this.relayUrl}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: bytes }),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? ""}`);
    return json;
  }

  /** Enrols through the relay's Enrolment in the same process (the relay must allow ghosts). */
  async enroll(enrolment: Enrolment) {
    const r = await enrolment.enrollGhost({
      handle: this.handle,
      appAttestPk: this.k.attestPk,
      playerBoxPk: this.k.boxPk,
      nearPk: this.k.nearPk,
    });
    this.accountId = r.account_id;
    return r;
  }

  /** Joins the lobby on chain with the ghost's own function-call key, as a phone does. */
  join(provider: JsonRpcProvider, contract: string, matchId: string) {
    return joinMatchWithKey(provider, contract, this.accountId, this.nearSeed, matchId);
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
        else if (m["type"] === "keys") this.setKeys(String(m["sealed"]));
        else if (m["type"] === "hud") this.takeHud(String(m["sealed"]));
        else if (m["type"] === "handler") {
          const line = openSignedVoiceLine(this.boxSk, unb64(String(m["sealed"])), this.trust.refereePk);
          this.handlerLines.push(line.text);
        } else if (m["type"] === "rejected") this.rejections.push(m);
      };
      ws.onclose = (ev) => reject(new Error(`HUD socket closed: ${ev.code} ${ev.reason}`));
      ws.onerror = () => reject(new Error("HUD socket error"));
    });
  }

  closeHud() {
    this.ws?.close();
  }

  /** After Start: fetches its own sealed PlayerKeys from the signed zone view, as a phone does. */
  async fetchKeys(matchId: string) {
    const r = await this.request<{ keys: { sealed: string }[] }>("GET", `/matches/${matchId}/zone`);
    const mine = r.keys[0];
    if (!mine) throw new Error(`${this.handle} got no keys for ${matchId}`);
    this.setKeys(mine.sealed);
  }

  /** Opens SignedPlayerKeys sealed to this ghost; throws unless the pinned referee signed them. */
  setKeys(sealed: string) {
    this.keys = openSignedPlayerKeys(this.boxSk, unb64(sealed), this.trust.refereePk);
  }

  /** Opens a SignedHud, as a phone does: also from a carry answer (`hud`). */
  takeHud(sealed: string) {
    const hud = openSignedHud(this.boxSk, unb64(sealed), this.trust.refereePk);
    if (hud.tick > (this.huds.at(-1)?.tick ?? 0)) this.huds.push(hud);
    if (hud.status === 1) this.out = true;
  }

  /**
   * A signed request sealed to the relay's carry key, for another phone to post to /carry: what
   * a phone without signal hands to the mesh.
   */
  carried(method: string, path: string, body: unknown, relayBoxPk: Uint8Array): Uint8Array {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const { timeMs, sig } = signRequest(this.signed(method, path, bytes), this.nearSeed);
    return sealCarry(relayBoxPk, {
      account: this.accountId,
      timeMs: BigInt(timeMs),
      method,
      path,
      body: bytes,
      sig,
    });
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
    return seal(refereeBoxPk, encodeBatchEnvelope({ batch, assertion }), SealContext.batch);
  }
}
