// The app's state and every action a screen can take. Screens read `app` and call its methods;
// nothing else talks to the relay, NEAR or the native modules.

import type { PlayerKeys } from "@tail/protocol";
import Constants from "expo-constants";
import { useSyncExternalStore } from "react";
import { Share } from "react-native";
import TailRadio from "../../modules/tail-radio";
import { meshProfile } from "../carry/mesh";
import { offlineProtocolLink } from "../carry/sdk";
import { openPlayerKeys } from "../game/hud";
import { checkReceipts, type Meeting, meetings, presenceJson, type ReceiptResult } from "../game/receipts";
import { type CarryPlan, HuntSession } from "../game/session";
import { checkedZone, type Zone } from "../game/zone";
import { enrol } from "../identity/enrol";
import { forgetAccount, type Identity, loadIdentity, nearSigner } from "../identity/identity";
import { keychain } from "../identity/keychain";
import { anchoredRoots, matchFacts } from "../near/chain";
import { NearRpc } from "../near/rpc";
import { PLAYER_GAS } from "../near/tx";
import { payoutProblem, withdrawCall, withdrawGas } from "../near/withdraw";
import {
  type CarryKey,
  isMatchId,
  type MatchView,
  type MatchZone,
  matchIdBytes,
  type NewMatch,
  OpenLobbyError,
  RelayClient,
  RelayError,
  type RelayInfo,
  readJoin,
} from "../relay/client";
import { HudSocket } from "../relay/hud";
import { checkedRefereeBox } from "../relay/referee";
import { assertWith, attestor, radioPort } from "./device";
import { files } from "./files";
import { decodeMatchRecord, emptyRecord, encodeMatchRecord, type MatchRecord } from "./persist";
import { type Page, type Route, routeFor } from "./route";

/** The busy label while a typed lobby code is looked up; Home shows it on its button. */
export const FINDING_LOBBY = "Finding the lobby";

export interface Settings {
  relayUrl: string;
  /** The web replay (apps/web); the results screen opens `<replayUrl>/?match=<id>`. */
  replayUrl: string;
  rpcUrl: string;
  contractId: string;
  /**
   * Run the Offline Protocol mesh during a hunt (carry/mesh.ts). Off by default: whether the
   * mesh's Bluetooth advertising leaves room for TAIL's beacon token is not measured yet.
   */
  meshCarry: boolean;
}

export interface RecentMatch {
  matchId: string;
  atMs: number;
}

const extra = (Constants.expoConfig?.extra ?? {}) as { contractId?: string | null; nearNetwork?: string };
/** The NEAR network this build plays on (app.config.ts); testnet unlocks free top-ups. */
export const NEAR_NETWORK = extra.nearNetwork ?? "testnet";
/** A testnet top-up: 10 test USDC from the relay, in 6-decimal units. */
export const TOP_UP = 10_000_000n;

const DEFAULTS: Settings = {
  relayUrl: "",
  rpcUrl: "https://test.rpc.fastnear.com",
  contractId: extra.contractId ?? "",
  replayUrl: "",
  meshCarry: false,
};

/** Settings from the file; anything it does not hold (or holds from an older build) is the default. */
function readSettings(text: string): Settings {
  const o = JSON.parse(text) as Partial<Record<keyof Settings, unknown>>;
  const str = (k: "relayUrl" | "replayUrl" | "rpcUrl" | "contractId") =>
    typeof o[k] === "string" ? (o[k] as string) : DEFAULTS[k];
  return {
    relayUrl: str("relayUrl"),
    replayUrl: str("replayUrl"),
    rpcUrl: str("rpcUrl"),
    contractId: str("contractId"),
    meshCarry: o.meshCarry === true,
  };
}

const SETTINGS_FILE = "settings.json";
const CURRENT_FILE = "current.json";
const FLAGS_FILE = "flags.json";
const RECENT_FILE = "recent.json";
const matchFile = (id: string) => `match-${id}.json`;
const POLL_MS = 3_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Briefing {
  keys: PlayerKeys;
  refereeBoxPk: Uint8Array;
  /** The referee key the match pinned, as NEAR has it (read through the phone's own RPC). */
  refereePk: Uint8Array;
  /** The relay's keys for carried reports; null when the relay has none (carry stays off). */
  carryKey: CarryKey | null;
}

/** Results' check that every report is in the log anchored on NEAR (game/receipts.ts). */
export type Receipts =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none"; why: string }
  | { kind: "done"; result: ReceiptResult }
  | { kind: "error"; message: string };

class AppModel {
  settings: Settings = DEFAULTS;
  identity: Identity | null = null;
  matchId: string | null = null;
  match: MatchView | null = null;
  /** The signed part of the open match (zone, this player's keys, Start failure); host and players only. */
  matchZone: MatchZone | null = null;
  /** Create was refused because this host already has this lobby open; Create offers to open it. */
  openLobby: string | null = null;
  balance: bigint | null = null;
  briefing: Briefing | null = null;
  session: HuntSession | null = null;
  here: { lat: number; lon: number; acc: number } | null = null;
  showSettings = false;
  /** A page opened from home: the create form or the QR scanner. */
  page: Page | null = null;
  primerSeen = true;
  recent: RecentMatch[] = [];
  /**
   * Home and Profile: this account's contract balance in the match token, that token, the gas
   * the contract wants for a withdraw, and where withdrawals go (null: not registered yet).
   */
  wallet: { token: string; balance: bigint; withdrawGas: bigint; payout: string | null } | null = null;
  /** What the relay says about itself (relay/client.ts `info`); null until read. */
  relayInfo: RelayInfo | null = null;
  /** The player chose to see results while the match still runs (after being tagged). */
  resultsNow = false;
  /** Tags won in the open match as its file had them when opened (a relaunch has no session). */
  private savedTags = 0;
  receipts: Receipts = { kind: "idle" };
  /** Presence proofs this player can share once the match has ended; null until looked up. */
  meetings: Meeting[] | null = null;
  private relayClient: RelayClient | null = null;
  busy: string | null = null;
  error: string | null = null;
  ready = false;

  private version = 0;
  private listeners = new Set<() => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private stopLocating: (() => void) | null = null;

  // ── Store plumbing ──────────────────────────────────────────────────────────────────────

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** One client per relay address, so the contract id it reads from /health is asked once. */
  get relay(): RelayClient {
    if (this.relayClient?.baseUrl !== this.settings.relayUrl.replace(/\/+$/, ""))
      this.relayClient = new RelayClient(this.settings.relayUrl);
    return this.relayClient;
  }
  private get rpc(): NearRpc {
    return new NearRpc(this.settings.rpcUrl);
  }

  get route(): Route {
    return routeFor({
      ready: this.ready,
      enrolled: !!this.identity?.accountId,
      primerSeen: this.primerSeen,
      matchId: this.matchId,
      page: this.page,
      resultsNow: this.resultsNow,
      session: this.session ? { over: this.session.snapshot().over } : null,
      phase: this.match?.phase,
      out: !!this.match?.chain?.players.find((p) => p.accountId === this.me)?.out,
    });
  }

  get me(): string | null {
    return this.identity?.accountId ?? null;
  }

  /** Runs one user action: shows it as busy, keeps its error for the screen. */
  private async act<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.busy = label;
    this.error = null;
    this.emit();
    try {
      return await fn();
    } catch (e) {
      this.error = message(e);
      return undefined;
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  // ── Start-up and settings ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    try {
      const s = files.read(SETTINGS_FILE);
      if (s) this.settings = readSettings(s);
      this.identity = await loadIdentity(keychain);
      const flags = files.read(FLAGS_FILE);
      this.primerSeen = flags ? (JSON.parse(flags) as { primerSeen?: boolean }).primerSeen === true : false;
      const recent = files.read(RECENT_FILE);
      this.recent = recent ? (JSON.parse(recent) as RecentMatch[]) : [];
      const cur = files.read(CURRENT_FILE);
      const id = cur ? (JSON.parse(cur) as { matchId?: string }).matchId : undefined;
      if (id && isMatchId(id)) this.setMatch(id);
    } catch (e) {
      this.error = message(e);
    }
    this.ready = true;
    this.emit();
  }

  saveSettings(s: Settings): void {
    this.settings = { ...s, relayUrl: s.relayUrl.trim().replace(/\/+$/, "") };
    files.write(SETTINGS_FILE, JSON.stringify(this.settings));
    this.showSettings = false;
    this.emit();
    void this.checkRelay();
  }

  finishPrimer(): void {
    this.primerSeen = true;
    files.write(FLAGS_FILE, JSON.stringify({ primerSeen: true }));
    this.emit();
  }

  openPage(page: Page | null): void {
    this.page = page;
    this.error = null;
    this.openLobby = null;
    this.emit();
  }

  showResults(): void {
    this.resultsNow = true;
    this.emit();
  }

  /** The zone the relay sent, only if it matches the chain's commitment. */
  get zone(): Zone | null {
    return checkedZone(this.matchZone?.zone ?? null, this.match?.chain?.zoneHash ?? null);
  }

  /** Why the open match's last Start failed, as the relay told the host and players. */
  get startError(): string | null {
    return this.matchZone?.error ?? null;
  }

  /** Home: reads this account's balance in the contract's first allowed token. */
  refreshWallet(): Promise<void> {
    const me = this.me;
    if (!me || !this.settings.contractId) return Promise.resolve();
    return (async () => {
      try {
        const contract = this.settings.contractId;
        const cfg = await this.rpc.view<{ allowed_tokens: string[] } & Record<string, unknown>>(
          contract,
          "get_config",
          {},
        );
        const token = cfg.allowed_tokens[0];
        if (!token) return;
        const [bal, payout] = await Promise.all([
          this.rpc.view<string>(contract, "get_balance", { account_id: me, token }),
          this.rpc.view<string | null>(contract, "get_payout", { account_id: me }),
        ]);
        this.wallet = { token, balance: BigInt(bal), withdrawGas: withdrawGas(cfg), payout };
        this.emit();
      } catch (e) {
        this.error = message(e);
        this.emit();
      }
    })();
  }

  /**
   * Withdrawals would land on this account itself, which holds only this phone's game key, so
   * the tokens could never leave it. The first withdraw must name a wallet (`to`).
   */
  get needsPayout(): boolean {
    return !!this.me && this.wallet?.payout === this.me;
  }

  /** Why `to` cannot be the payout wallet, or null when it can (Profile checks as you type). */
  payoutProblem(to: string): string | null {
    return payoutProblem(to, this.me ?? "", this.settings.contractId);
  }

  /**
   * Sends the whole contract balance to the payout account. While that is still this account,
   * `to` names the wallet, which becomes the payout for good (the contract sets it once).
   */
  withdraw(to?: string) {
    return this.act("Withdrawing", async () => {
      const w = this.wallet;
      if (!w || w.balance === 0n) throw new Error("Nothing to withdraw.");
      const id = this.need();
      let wallet: string | undefined;
      if (this.needsPayout) {
        const problem = this.payoutProblem(to ?? "");
        if (problem) throw new Error(problem);
        wallet = (to ?? "").trim();
      }
      await this.rpc.functionCall(
        { accountId: id.accountId as string, publicKey: id.nearPk, secretKey: id.nearSk },
        this.settings.contractId,
        withdrawCall({
          token: w.token,
          amount: w.balance,
          gas: w.withdrawGas,
          ...(wallet === undefined ? {} : { to: wallet }),
        }),
      );
      void this.refreshWallet();
    });
  }

  toggleSettings(on: boolean): void {
    this.showSettings = on;
    this.emit();
  }

  // ── Enrolment ───────────────────────────────────────────────────────────────────────────

  enrol(handle: string) {
    return this.act("Checking this phone", async () => {
      if (!this.settings.relayUrl) throw new Error("Set the relay address first.");
      const id = this.identity ?? (await loadIdentity(keychain));
      this.identity = await enrol(handle, id, {
        relay: this.relay,
        attest: attestor,
        secrets: keychain,
        onStep: (label) => {
          this.busy = label;
          this.emit();
        },
      });
    });
  }

  // ── Location for creating a match (the zone is centred on the host) ─────────────────────

  startLocating(): void {
    if (this.stopLocating) return;
    const sub = TailRadio.addListener("onFix", (f) => {
      if (f.acc < 0) return;
      this.here = { lat: f.lat, lon: f.lon, acc: f.acc };
      this.emit();
    });
    TailRadio.startLocation();
    this.stopLocating = () => {
      sub.remove();
      TailRadio.stopLocation();
    };
  }

  endLocating(): void {
    this.stopLocating?.();
    this.stopLocating = null;
  }

  // ── Lobby ───────────────────────────────────────────────────────────────────────────────

  createMatch(m: Omit<NewMatch, "zone" | "safehouses" | "startByMs"> & { radiusM: number }) {
    return this.act("Opening a lobby", async () => {
      this.openLobby = null;
      if (!this.here) throw new Error("Waiting for your location.");
      const { radiusM, ...rest } = m;
      let matchId: string;
      try {
        ({ matchId } = await this.relay.createMatch(nearSigner(this.need()), {
          ...rest,
          zone: { latE7: Math.round(this.here.lat * 1e7), lonE7: Math.round(this.here.lon * 1e7), radiusM },
          safehouses: [],
          // The lobby stays open for an hour; after that anyone can abort it and refund.
          startByMs: Date.now() + 60 * 60_000,
        }));
      } catch (e) {
        if (e instanceof OpenLobbyError) this.openLobby = e.matchId;
        throw e;
      }
      this.setMatch(matchId);
      await this.callContract("join_match", { match_id: matchId });
    });
  }

  /**
   * Opens a lobby from whatever the player has: a short code (asked of the relay, which knows
   * only open lobbies), a full match id, or a tail://join link holding either.
   */
  openMatch(input: string) {
    const target = readJoin(input);
    if (!target) {
      this.error = "Enter the lobby code, like K7M-4QX.";
      this.emit();
      return Promise.resolve();
    }
    if ("matchId" in target) {
      this.setMatch(target.matchId);
      return Promise.resolve();
    }
    return this.act(FINDING_LOBBY, async () => {
      this.setMatch(await this.relay.resolveCode(target.code));
    });
  }

  join() {
    return this.act("Joining", () => this.callContract("join_match", { match_id: this.matchId }));
  }

  leave() {
    return this.act("Leaving", async () => {
      await this.callContract("leave_lobby", { match_id: this.matchId });
      this.closeMatch();
    });
  }

  start() {
    return this.act("Starting", async () => {
      await this.relay.startMatch(nearSigner(this.need()), this.needMatch());
      await this.refresh();
    });
  }

  /** Which referee the relay says it runs; null when it does not say (Results words it). */
  get refereeKind(): RelayInfo["referee"] {
    return this.relayInfo?.referee ?? null;
  }

  /** A test relay may fill a lobby seat with a test player; the lobby shows its button only then. */
  get testPlayers(): boolean {
    return this.relayInfo?.testPlayers ?? false;
  }

  /** The relay plays on another contract than this app is set to: balances and joins would miss. */
  get contractMismatch(): string | null {
    const theirs = this.relayInfo?.contract;
    return theirs && theirs !== this.settings.contractId ? theirs : null;
  }

  /** Reads what the relay says about itself. No answer leaves the safe defaults. */
  async checkRelay(): Promise<void> {
    if (!this.settings.relayUrl) return;
    try {
      this.relayInfo = await this.relay.info();
      this.emit();
    } catch {
      // Unreachable relay: no test players and no mismatch to report; the next call says why.
    }
  }

  /** Test relays only: play as a new handle on this phone (keys kept; see forgetAccount). */
  async startOver(): Promise<void> {
    if (!this.testPlayers || !this.identity) return;
    await forgetAccount(keychain);
    this.identity = { ...this.identity, accountId: null };
    this.wallet = null;
    this.page = null;
    this.emit();
  }

  /** Pull to refresh on Home and Profile: the balance and what the relay says about itself. */
  async refreshAccount(): Promise<void> {
    await Promise.all([this.refreshWallet(), this.checkRelay()]);
  }

  /** The user chose the relay's contract after seeing the mismatch. */
  switchToRelayContract(): void {
    const theirs = this.contractMismatch;
    if (!theirs) return;
    this.saveSettings({ ...this.settings, contractId: theirs });
    void this.refreshWallet();
  }

  addTestPlayer() {
    return this.act("Adding a test player", async () => {
      const id = this.need();
      if (!this.matchId) throw new Error("Open a lobby first.");
      await this.relay.addTestPlayer(nearSigner(id), this.matchId);
      await this.refresh();
    });
  }

  topUp(amount: bigint) {
    return this.act("Topping up", async () => {
      const me = this.need();
      await this.relay.topUp(nearSigner(me), me.accountId as string, amount);
      await this.refresh();
      void this.refreshWallet();
    });
  }

  private async callContract(method: string, args: object): Promise<void> {
    const id = this.need();
    if (!this.settings.contractId) throw new Error("Set the contract in Settings.");
    await this.rpc.functionCall(
      { accountId: id.accountId as string, publicKey: id.nearPk, secretKey: id.nearSk },
      this.settings.contractId,
      { methodName: method, args, gas: PLAYER_GAS },
    );
    await this.refresh();
  }

  private setMatch(id: string): void {
    this.matchId = id;
    this.page = null;
    this.resultsNow = false;
    this.recent = [{ matchId: id, atMs: Date.now() }, ...this.recent.filter((r) => r.matchId !== id)].slice(
      0,
      5,
    );
    files.write(RECENT_FILE, JSON.stringify(this.recent));
    this.match = null;
    this.matchZone = null;
    this.openLobby = null;
    this.briefing = null;
    this.receipts = { kind: "idle" };
    this.meetings = null;
    try {
      this.savedTags = this.loadRecord(id).tags;
    } catch {
      // An unreadable file only costs the tag count here; beginHunt reads it again and stops on it.
      this.savedTags = 0;
    }
    files.write(CURRENT_FILE, JSON.stringify({ matchId: id }));
    this.startPolling();
    this.emit();
  }

  /** Back to home. Unsent batches of an unfinished match stay in its file. */
  closeMatch(): void {
    this.stopPolling();
    this.session?.stop();
    this.session = null;
    this.briefing = null;
    this.matchId = null;
    this.match = null;
    this.matchZone = null;
    this.resultsNow = false;
    files.remove(CURRENT_FILE);
    void this.refreshWallet();
    this.emit();
  }

  private startPolling(): void {
    this.stopPolling();
    void this.refresh();
    this.poll = setInterval(() => void this.refresh(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  async refresh(): Promise<void> {
    const id = this.matchId;
    if (!id) return;
    try {
      const m = await this.relay.getMatch(id);
      if (this.matchId !== id) return;
      this.match = m;
      // Once this player's keys are in, the signed view has nothing more to say.
      if (!this.matchZone?.keys.length && this.inMatch(m)) {
        const z = await this.loadZone(id);
        if (this.matchId !== id) return;
        this.matchZone = z;
      }
      if (m.chain && this.me && this.settings.contractId) {
        const bal = await this.rpc.view<string>(this.settings.contractId, "get_balance", {
          account_id: this.me,
          token: m.chain.token,
        });
        this.balance = BigInt(bal);
      }
      // Nothing changes in the lobby once the hunt runs; the HUD socket takes over.
      if (this.session || m.phase === "ended" || m.phase === "failed") this.stopPolling();
    } catch (e) {
      this.error = message(e);
    }
    this.emit();
  }

  /** The host and the players are who the relay shows the signed view to (invites aside). */
  private inMatch(m: MatchView): boolean {
    const me = this.me;
    return !!me && (m.host === me || !!m.chain?.players.some((p) => p.accountId === me));
  }

  /** The signed view, or null when the relay says this account is not in the match. */
  private async loadZone(matchId: string): Promise<MatchZone | null> {
    try {
      return await this.relay.matchZone(nearSigner(this.need()), matchId);
    } catch (e) {
      // The chain view the relay checks may lag a join by a few seconds; the next poll asks again.
      if (e instanceof RelayError && e.status === 403) return null;
      throw e;
    }
  }

  // ── Briefing and hunt ───────────────────────────────────────────────────────────────────

  /**
   * Opens this player's sealed keys and checks them, and the referee's box key, against the
   * referee key the match pinned on NEAR, read here through the phone's own RPC: the relay
   * relays both and could swap either. Also fetches the relay's carry keys while online.
   */
  brief() {
    return this.act("Reading your orders", async () => {
      const id = this.need();
      const m = this.match;
      if (!m?.chain) throw new Error("The match is not on chain yet.");
      const facts = await matchFacts(this.rpc, this.settings.contractId, m.matchId);
      if (!facts) throw new Error("The match is not on chain yet.");
      // The poll may not have read the keys yet (they arrive with Start); ask for them now.
      if (!this.matchZone?.keys.length) this.matchZone = await this.loadZone(m.matchId);
      const seat = this.matchZone?.keys.find((k) => k.accountId === id.accountId);
      if (!seat) throw new Error("You are not in this match.");
      let keys: PlayerKeys;
      try {
        keys = openPlayerKeys(id.boxSk, seat.sealed, facts.refereePk, {
          matchId: matchIdBytes(m.matchId),
          player: seat.player,
        });
      } catch {
        throw new Error("Your orders were not signed by the referee. Try again, or ask the host.");
      }
      const refereeBoxPk = checkedRefereeBox(await this.relay.refereeKeys(), facts.refereePk);
      const carryKey = this.settings.meshCarry ? await this.relay.carryKey().catch(() => null) : null;
      this.briefing = { keys, refereeBoxPk, refereePk: facts.refereePk, carryKey };
    });
  }

  private carryPlan(b: Briefing, matchId: string): CarryPlan {
    if (!this.settings.meshCarry) return { kind: "off", why: "Mesh carry is off in Settings." };
    if (!b.carryKey) return { kind: "off", why: "The relay doesn't take carried reports." };
    const relay = this.relay;
    return {
      kind: "on",
      key: b.carryKey,
      link: offlineProtocolLink(meshProfile(matchIdBytes(matchId))),
      forward: (envelope) => relay.forwardCarry(envelope),
    };
  }

  beginHunt(): void {
    const id = this.need();
    const b = this.briefing;
    const m = this.match;
    if (!b || !m?.chain || !id.attestKeyId || this.session) return;
    const matchId = m.matchId;
    const record = this.loadRecord(matchId);
    const signer = nearSigner(id);
    const relay = this.relay;
    this.session = new HuntSession({
      matchIdHex: matchId,
      keys: b.keys,
      stake: m.chain.stake,
      boxSk: id.boxSk,
      refereeBoxPk: b.refereeBoxPk,
      refereePk: b.refereePk,
      record,
      radio: radioPort,
      assert: assertWith(id.attestKeyId),
      batchRequest: (sealed) => relay.batchRequest(signer, matchId, sealed),
      upload: (req) => relay.uploadBatch(req),
      save: (r) => files.write(matchFile(matchId), encodeMatchRecord({ matchId, ...r })),
      hud: (onMessage, onState) =>
        new HudSocket({
          url: relay.hudUrl(matchId, signer.accountId),
          signer,
          matchId: matchIdBytes(matchId),
          onMessage,
          onState,
        }),
      carry: this.carryPlan(b, matchId),
      zone: this.zone?.zone ?? null,
    });
    this.session.subscribe(() => this.emit());
    this.stopPolling();
    this.session.start();
    this.emit();
  }

  loadRecord(matchId: string): MatchRecord {
    const text = files.read(matchFile(matchId));
    return text ? decodeMatchRecord(text) : emptyRecord(matchId);
  }

  /** Tags this player won in the open match: live from the hunt, else from the match file. */
  get tags(): number {
    return this.session?.snapshot().tags ?? this.savedTags;
  }

  finishMatch(): void {
    this.closeMatch();
  }

  // ── Results: receipts and presence proofs ───────────────────────────────────────────────

  /**
   * Checks every report this phone sent against the newest root NEAR anchored for the match:
   * End's once there is one, else the latest checkpoint. Roots and players come from NEAR
   * through the phone's RPC; the relay only supplies audit paths, which are verified here.
   */
  async checkReceipts(): Promise<void> {
    const id = this.matchId;
    const me = this.me;
    if (!id || !me || this.receipts.kind === "checking") return;
    this.receipts = { kind: "checking" };
    this.emit();
    try {
      const contract = this.settings.contractId;
      const [facts, roots] = await Promise.all([
        matchFacts(this.rpc, contract, id),
        anchoredRoots(this.rpc, contract, id),
      ]);
      const player = facts?.players.indexOf(me) ?? -1;
      const root = roots.final ?? roots.all.at(-1) ?? null;
      const reports = this.loadRecord(id).reports;
      if (player < 0) this.receipts = { kind: "none", why: "You are not a player in this match on NEAR." };
      else if (!root) this.receipts = { kind: "none", why: "No log root is anchored on NEAR yet." };
      else if (reports.length === 0)
        this.receipts = { kind: "none", why: "This phone kept no reports for this match." };
      else {
        const relay = this.relay;
        const result = await checkReceipts({
          player,
          reports,
          root,
          final: roots.final !== null,
          proofs: (leaf, size) => relay.inclusion(id, leaf, size),
        });
        this.receipts = { kind: "done", result };
      }
    } catch (e) {
      this.receipts = { kind: "error", message: message(e) };
    }
    if (this.matchId === id) this.emit();
  }

  /**
   * After End: the plaintext log from the replay bundle, turned into one presence proof per
   * player this phone met, each verified against End's root on NEAR before it is offered.
   */
  async findMeetings(): Promise<void> {
    const id = this.matchId;
    const me = this.me;
    if (!id || !me || this.meetings !== null) return;
    try {
      const contract = this.settings.contractId;
      const [facts, roots] = await Promise.all([
        matchFacts(this.rpc, contract, id),
        anchoredRoots(this.rpc, contract, id),
      ]);
      const player = facts?.players.indexOf(me) ?? -1;
      if (!facts || player < 0 || !roots.final) return;
      const log = await this.relay.replayLog(nearSigner(this.need()), id);
      const found = meetings({
        matchId: matchIdBytes(id),
        contract,
        log,
        me: player,
        players: facts.players,
        root: roots.final,
      });
      if (this.matchId === id) this.meetings = found;
    } catch {
      // The replay is not open yet, or its trails were purged: no proofs to offer, nothing broken.
      return;
    }
    this.emit();
  }

  /** Shares the proof of having met `account` as a JSON document. */
  async shareMeeting(account: string): Promise<void> {
    const m = this.meetings?.find((x) => x.other === account);
    if (!m) return;
    await Share.share({ title: "TAIL presence proof", message: presenceJson(m) });
  }

  private need(): Identity {
    if (!this.identity?.accountId) throw new Error("Sign in first.");
    return this.identity;
  }

  private needMatch(): string {
    if (!this.matchId) throw new Error("No match open.");
    return this.matchId;
  }
}

export const app = new AppModel();

/** Re-renders the calling component whenever the app state changes. */
export function useApp(): AppModel {
  useSyncExternalStore(app.subscribe, app.getVersion);
  return app;
}
