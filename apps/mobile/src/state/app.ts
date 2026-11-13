// The app's state and every action a screen can take. Screens read `app` and call its methods;
// nothing else talks to the relay, NEAR or the native modules.

import type { PlayerKeys } from "@tail/protocol";
import Constants from "expo-constants";
import { useSyncExternalStore } from "react";
import TailRadio from "../../modules/tail-radio";
import { type CarryConfig, MeshCarry } from "../carry/mesh";
import { genesis } from "../game/batch";
import { openPlayerKeys } from "../game/hud";
import { HuntSession } from "../game/session";
import { checkedZone, type Zone } from "../game/zone";
import { enrol } from "../identity/enrol";
import { forgetAccount, type Identity, loadIdentity, nearSigner } from "../identity/identity";
import { keychain } from "../identity/keychain";
import { NearRpc } from "../near/rpc";
import { PLAYER_GAS } from "../near/tx";
import {
  isMatchId,
  type MatchView,
  matchIdBytes,
  type NewMatch,
  RelayClient,
  type RelayInfo,
  readJoin,
} from "../relay/client";
import { HudSocket } from "../relay/hud";
import { checkedRefereeBox } from "../relay/referee";
import { assertWith, attestor, radioPort } from "./device";
import { files } from "./files";
import { decodeMatchRecord, encodeMatchRecord, type MatchRecord } from "./persist";

/** The busy label while a typed lobby code is looked up; Home shows it on its button. */
export const FINDING_LOBBY = "Finding the lobby";

export interface Settings extends CarryConfig {
  relayUrl: string;
  /** The web replay (apps/web); the results screen opens `<replayUrl>/?match=<id>`. */
  replayUrl: string;
  rpcUrl: string;
  contractId: string;
}

/** Screens opened from Home, before any match. */
export type Page = "create" | "scan" | "profile";

export type Route =
  | "loading"
  | "enrol"
  | "primer"
  | "home"
  | Page
  | "lobby"
  | "briefing"
  | "hunt"
  | "results";

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
  nodeAddress: "",
  serverUrl: "",
  replayUrl: "",
};

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
}

class AppModel {
  settings: Settings = DEFAULTS;
  identity: Identity | null = null;
  matchId: string | null = null;
  match: MatchView | null = null;
  balance: bigint | null = null;
  briefing: Briefing | null = null;
  session: HuntSession | null = null;
  here: { lat: number; lon: number; acc: number } | null = null;
  showSettings = false;
  /** A page opened from home: the create form or the QR scanner. */
  page: Page | null = null;
  primerSeen = true;
  recent: RecentMatch[] = [];
  /** Home: this account's contract balance in the match token, and that token. */
  wallet: { token: string; balance: bigint } | null = null;
  /** What the relay says about itself (relay/client.ts `info`); null until read. */
  relayInfo: RelayInfo | null = null;
  /** The player chose to see results while the match still runs (after being tagged). */
  resultsNow = false;
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

  get relay(): RelayClient {
    return new RelayClient(this.settings.relayUrl);
  }
  private get rpc(): NearRpc {
    return new NearRpc(this.settings.rpcUrl);
  }

  get route(): Route {
    if (!this.ready) return "loading";
    if (!this.identity?.accountId) return "enrol";
    if (!this.primerSeen) return "primer";
    if (!this.matchId) return this.page ?? "home";
    if (this.resultsNow) return "results";
    if (this.session) return this.session.snapshot().over ? "results" : "hunt";
    const phase = this.match?.phase;
    if (phase === "running" || phase === "ending") return "briefing";
    if (phase === "ended") return "results";
    return "lobby";
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
      if (s) this.settings = { ...DEFAULTS, ...(JSON.parse(s) as Partial<Settings>) };
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
    this.emit();
  }

  showResults(): void {
    this.resultsNow = true;
    this.emit();
  }

  /** The zone the relay sent, only if it matches the chain's commitment. */
  get zone(): Zone | null {
    const m = this.match;
    return checkedZone(m?.zone ?? null, m?.chain?.zoneHash ?? null);
  }

  /** Home: reads this account's balance in the contract's first allowed token. */
  refreshWallet(): Promise<void> {
    const me = this.me;
    if (!me || !this.settings.contractId) return Promise.resolve();
    return (async () => {
      try {
        const cfg = await this.rpc.view<{ allowed_tokens: string[] }>(
          this.settings.contractId,
          "get_config",
          {},
        );
        const token = cfg.allowed_tokens[0];
        if (!token) return;
        const bal = await this.rpc.view<string>(this.settings.contractId, "get_balance", {
          account_id: me,
          token,
        });
        this.wallet = { token, balance: BigInt(bal) };
        this.emit();
      } catch (e) {
        this.error = message(e);
        this.emit();
      }
    })();
  }

  /** Sends the whole contract balance to this account (the payout account fixed at enrolment). */
  withdraw() {
    return this.act("Withdrawing", async () => {
      const w = this.wallet;
      if (!w || w.balance === 0n) throw new Error("Nothing to withdraw.");
      const id = this.need();
      await this.rpc.functionCall(
        { accountId: id.accountId as string, publicKey: id.nearPk, secretKey: id.nearSk },
        this.settings.contractId,
        { methodName: "withdraw", args: { token: w.token, amount: w.balance.toString() }, gas: PLAYER_GAS },
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
      if (!this.here) throw new Error("Waiting for your location.");
      const { radiusM, ...rest } = m;
      const { matchId } = await this.relay.createMatch(nearSigner(this.need()), {
        ...rest,
        zone: { latE7: Math.round(this.here.lat * 1e7), lonE7: Math.round(this.here.lon * 1e7), radiusM },
        safehouses: [],
        // The lobby stays open for an hour; after that anyone can abort it and refund.
        startByMs: Date.now() + 60 * 60_000,
      });
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
    this.briefing = null;
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

  // ── Briefing and hunt ───────────────────────────────────────────────────────────────────

  /** Opens this player's sealed keys and checks the referee's box key against the chain. */
  brief() {
    return this.act("Reading your orders", async () => {
      const id = this.need();
      const m = this.match;
      const chain = m?.chain;
      if (!m || !chain) throw new Error("The match is not on chain yet.");
      const seat = m.keys.find((k) => k.accountId === id.accountId);
      if (!seat) throw new Error("You are not in this match.");
      const keys = openPlayerKeys(id.boxSk, seat.sealed, {
        matchId: matchIdBytes(m.matchId),
        player: seat.player,
      });
      const refereeBoxPk = checkedRefereeBox(await this.relay.refereeKeys(), chain.refereePk);
      this.briefing = { keys, refereeBoxPk };
    });
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
    const settings = this.settings;
    this.session = new HuntSession({
      matchIdHex: matchId,
      keys: b.keys,
      stake: m.chain.stake,
      boxSk: id.boxSk,
      refereeBoxPk: b.refereeBoxPk,
      chain: record.chain,
      outbox: record.outbox,
      radio: radioPort,
      assert: assertWith(id.attestKeyId),
      batchRequest: (sealed) => relay.batchRequest(signer, matchId, sealed),
      upload: (req) => relay.uploadBatch(req),
      save: (chain, outbox) =>
        files.write(matchFile(matchId), encodeMatchRecord({ matchId, chain, outbox: [...outbox] })),
      hud: (onMessage, onState) =>
        new HudSocket({
          url: relay.hudUrl(matchId, signer.accountId),
          signer,
          matchId: matchIdBytes(matchId),
          onMessage,
          onState,
        }),
      carry: (d) => new MeshCarry({ config: settings, matchId, ...d }),
      carryConfig: settings,
      zone: this.zone?.zone ?? null,
    });
    this.session.subscribe(() => this.emit());
    this.stopPolling();
    this.session.start();
    this.emit();
  }

  private loadRecord(matchId: string): MatchRecord {
    const text = files.read(matchFile(matchId));
    return text ? decodeMatchRecord(text) : { matchId, chain: genesis(), outbox: [] };
  }

  finishMatch(): void {
    this.closeMatch();
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
