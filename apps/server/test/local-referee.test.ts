// A whole ghost match through the in-process relay against the REAL referee: the native build of
// crates/referee-wasi in local mode (one process per command; its keys in a throwaway temp
// directory), with ContractChain applying the verdicts by the contract's rules. Nothing here
// talks to NEAR, OutLayer or NEAR AI. The other relay tests run on test/fakes.ts; this one is
// where the relay and the referee have to agree on every shape they exchange.
//
// Time runs fast. The match starts ten minutes in the past and the test steps the relay's loop
// itself (Matches.step), one tick per simulated 10 s: the relay's clock is the simulated one,
// and each tick hands the referee that time as `now_ms`, as crates/referee-wasi/scripts/match.ts
// does (the referee takes a `now_ms` that lags its own clock, never one ahead of it). The relay
// itself leaves referee time to the referee, so the test adds it in the transport.
//
// The script: three ghosts enrol unattested, join and start; the hunter strikes too early
// (refused), asks a NEAR hint with a question (the Handler answers from its template: the test
// gives the local referee no NEAR AI key), walks to its target and strikes once its signed HUD shows a full lock;
// the bystander's batch goes through the mesh (POST /carry) once, and a resend of an old batch
// is rejected. The match runs to End and is declassified, and the replay must pass the web
// verifier's checks against what the chain holds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  BATCH_MS,
  badLogSalts,
  concat,
  decodeCarryAck,
  decodeLogEntry,
  decodeSignedVerdict,
  equal,
  FixFlag,
  fromHex,
  hintPrice,
  LOCK_EPOCHS,
  logEntrySalt,
  merkleEmptyRoot,
  merkleLeaf,
  merkleRoot,
  merkleVerify,
  RefuseCode,
  RejectCode,
  type ReplayBundleV2,
  sha256,
  TICK_MS,
  toHex,
  utf8,
  verdictChainBreak,
  verifyCarryAck,
  verifyConsistency,
} from "@tail/protocol";
import type { ChainState } from "../../web/src/verify/anchor.ts";
import { decodeBundle } from "../../web/src/verify/bundle.ts";
import { verifyAll } from "../../web/src/verify/index.ts";
import { createRelay } from "../src/app.ts";
import { newCarryKeys } from "../src/carry.ts";
import { Store } from "../src/db.ts";
import { Ghost } from "../src/ghosts/ghost.ts";
import { CLEAN_TAG, positionAt, toLatLonE7 } from "../src/ghosts/trace.ts";
import { GuardedReferee, localTransport, RefereeClient, type RefereeTransport } from "../src/referee.ts";
import { ContractChain } from "./contract-chain.ts";
import { quietLog, until } from "./fakes.ts";

const CRATE = join(import.meta.dir, "../../../crates/referee-wasi");
const BIN = join(CRATE, "target/release/tail-referee");
const PARENT = "relay.testnet";
const CONTRACT = "tail.relay.testnet";
/** The App ID the referee pins in its code (crates/referee-wasi cmd/mod.rs `APP_ID`); the relay names the same. */
const APP_ID = "LKABS9RZAC.com.lkabs9rzac.tail";
const STAKE = 1_000_000n;
const DURATION_MS = 120_000;
const ZONE = { lat_e7: 423_550_000, lon_e7: -710_656_000, radius_m: 1500 };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

let keysDir = "";
const cleanup: (() => void)[] = [];

beforeAll(async () => {
  // Incremental: a no-op when the binary is current, about 15 s from a cold target directory.
  const build = Bun.spawn(["cargo", "build", "--release", "--locked", "--bin", "tail-referee"], {
    cwd: CRATE,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`building the local referee failed:\n${err.slice(-2000)}`);
  keysDir = mkdtempSync(join(tmpdir(), "tail-local-referee-"));
}, 300_000);

afterAll(() => {
  for (const f of cleanup.splice(0)) f();
  if (keysDir) rmSync(keysDir, { recursive: true, force: true });
});

describe("a match judged by the real (local) referee", () => {
  test("three ghosts play to End through the relay, and the replay verifies", async () => {
    const clock = { ms: Date.now() - 10 * 60_000 };
    /** Every referee answer, as it came back. */
    const answers: { cmd: string; result: Record<string, unknown> }[] = [];
    const local = localTransport({ bin: BIN, dir: keysDir, owner: PARENT, allowUnattested: true });
    const transport: RefereeTransport = async (cmd, input) => {
      const a = await local(cmd, cmd === "tick" ? { ...input, now_ms: clock.ms } : input);
      answers.push({ cmd, result: (a.answer as { result?: Record<string, unknown> }).result ?? {} });
      return a;
    };
    const referee = new GuardedReferee(new RefereeClient(transport), "local");
    const pins = await referee.pubkeys();
    // The App ID pinned in the referee's code is the one the relay names.
    expect(pins.appId).toBe(APP_ID);
    const chain = new ContractChain(
      { refereePk: pins.refereePk, vrfPk: pins.vrfPk, vrfSender: PARENT },
      () => clock.ms,
    );
    const store = new Store(":memory:");
    const relay = createRelay({
      store,
      chain,
      referee,
      log: quietLog(),
      parentAccount: PARENT,
      appId: APP_ID,
      environment: "development",
      token: "usdc.fakes.testnet",
      vrfSender: PARENT,
      carryKeys: newCarryKeys(),
      replay: {
        contract: CONTRACT,
        network: "testnet",
        refereeProject: `${PARENT}/tail-referee`,
        outlayerApi: "https://testnet-api.outlayer.ai",
        refereeKind: "local",
      },
      refereeHealth: () => referee.health(),
      testnet: true,
      allowGhosts: true,
      now: () => clock.ms,
    });
    // No timer runs the match: the test steps it, one tick per simulated TICK_MS.
    relay.matches.stop();
    const server = Bun.serve({ port: 0, fetch: relay.app.fetch, websocket: relay.websocket });
    cleanup.push(() => {
      server.stop(true);
    });
    const url = `http://localhost:${server.port}`;
    const get = async <T>(path: string) => (await (await relay.app.request(path)).json()) as T;

    // What a phone checks before sealing anything to the referee: the box key is the pinned one's.
    const served = await get<Record<string, string>>("/referee");
    expect(toHex(unb64(served["referee_pk"] as string))).toBe(toHex(pins.refereePk));
    const boxDigest = sha256(concat(utf8("tail/referee-box/v1"), pins.refereeBoxPk));
    expect(toHex(unb64(served["referee_box_pk"] as string))).toBe(toHex(pins.refereeBoxPk));
    expect(ed25519.verify(pins.boxPkSig, boxDigest, pins.refereePk)).toBe(true);
    // The VRF key in hex, as get_config and the replay bundle write it.
    expect(served["vrf_pk"]).toBe(toHex(pins.vrfPk));

    // ── enrol, lobby, start ──────────────────────────────────────────────────────
    const trust = { contract: CONTRACT, refereePk: pins.refereePk };
    const ghosts = ["a", "b", "c"].map((r) => new Ghost(`ghost-${r}`, url, trust));
    for (const g of ghosts) await g.enroll(relay.enrolment);
    const [host] = ghosts as [Ghost];
    const { match_id: id } = await host.request<{ match_id: string }>("POST", "/matches", {
      stake: STAKE.toString(),
      duration_ms: DURATION_MS,
      zone: ZONE,
      public_replay: true,
      min_players: 3,
      max_players: 3,
      start_by_ms: Date.now() + 600_000,
    });
    for (const g of ghosts) {
      chain.balances.set(g.accountId, STAKE);
      await chain.joinAsGhost(g.accountId, g.nearSeed, id);
    }
    const started = await host.request<{ keys: { account_id: string; sealed: string }[]; start_ms: number }>(
      "POST",
      `/matches/${id}/start`,
      {},
    );
    // Start hands the host only its own keys; every other player fetches its own.
    expect(started.keys.map((k) => k.account_id)).toEqual([host.accountId]);
    for (const g of ghosts) await g.fetchKeys(id);
    for (const g of ghosts) await g.connectHud(id);
    // The referee registered every device before Start, as unattested (no Apple attestation).
    expect(ghosts.map((g) => store.device(g.accountId)?.attested)).toEqual([0, 0, 0]);
    cleanup.push(() => {
      for (const g of ghosts) g.closeHud();
    });
    const startMs = started.start_ms;
    expect(startMs).toBe(clock.ms);
    const hunter = ghosts.find((g) => g.keys?.player === 0) as Ghost;
    const target = ghosts.find((g) => g.accountId === hunter.keys?.target) as Ghost;
    const bystander = ghosts.find((g) => g !== hunter && g !== target) as Ghost;
    const role = (g: Ghost) => (g === hunter ? "hunter" : g === target ? "target" : "bystander");
    const index = (g: Ghost) => g.keys?.player as number;

    // ── play ─────────────────────────────────────────────────────────────────────
    const { refereeBoxPk } = pins;
    const carry = await get<{ box_pk: string; ack_pk: string }>("/carry/key");
    const sent = new Map<Ghost, Uint8Array[]>(ghosts.map((g) => [g, []]));
    const hint = CLEAN_TAG.hint as NonNullable<typeof CLEAN_TAG.hint>;
    let hinted = false;
    let struck = false;
    let carried: { player: number; seq: number } | undefined;
    /** The bystander's batch with a simulated fix: authentic, so it takes its seq, but invalid. */
    let flagged: { seq: number } | undefined;
    const garbage = crypto.getRandomValues(new Uint8Array(200));
    for (let k = 1; store.match(id)?.phase !== "ended"; k++) {
      if (k > 20) throw new Error("the match did not end");
      // A strike before any contact is refused; the real one waits for a full lock.
      if (k === 1) hunter.strike();
      else if (!struck && (hunter.huds.at(-1)?.lock ?? 0) >= LOCK_EPOCHS) {
        hunter.strike();
        struck = true;
      }
      const live = ghosts.filter((g) => !g.out);
      const outbox: { g: Ghost; sealed: Uint8Array }[] = [];
      for (let s = 1; s <= TICK_MS / 1000; s++) {
        const t = startMs + (k - 1) * TICK_MS + s * 1000;
        const tS = (t - startMs) / 1000;
        const pos = new Map(live.map((g) => [g, positionAt(CLEAN_TAG.paths[role(g)], tS)]));
        for (const g of live) {
          const p = pos.get(g) as { east: number; north: number; speed: number };
          g.fix({
            tMs: BigInt(t),
            ...toLatLonE7({ latE7: ZONE.lat_e7, lonE7: ZONE.lon_e7 }, p.east, p.north),
            accM: CLEAN_TAG.accM,
            speedCmps: Math.round(p.speed * 100),
            // One fix of the bystander's at 33 s says the OS simulated it.
            flags: g === bystander && tS === 33 ? FixFlag.SimulatedBySoftware : 0,
          });
          for (const o of live) {
            const q = pos.get(o) as { east: number; north: number };
            if (o !== g && Math.hypot(p.east - q.east, p.north - q.north) <= CLEAN_TAG.radioM)
              g.hear(t, o.token(t), CLEAN_TAG.rssi);
          }
        }
        if (!hinted && tS >= hint.atS) {
          hunter.hint(hint.kind, hint.text);
          hinted = true;
        }
        if ((s * 1000) % BATCH_MS === 0)
          for (const g of live) {
            const sealed = g.sealedBatch(t, refereeBoxPk, APP_ID);
            if (g === bystander && tS === 35) flagged = { seq: (sent.get(g) as Uint8Array[]).length };
            outbox.push({ g, sealed });
          }
      }
      clock.ms = startMs + k * TICK_MS;
      for (const { g, sealed } of outbox) {
        const mine = sent.get(g) as Uint8Array[];
        const body = { match_id: id, sealed: b64(sealed) };
        if (g === bystander && k === 3 && mine.length % 2 === 1) {
          // No signal: the target carries the bystander's signed request to the relay.
          carried = { player: index(g), seq: mine.length };
          const envelope = g.carried("POST", "/batch", body, unb64(carry.box_pk));
          const res = await fetch(`${url}/carry`, { method: "POST", body: envelope });
          const answer = (await res.json()) as { ack: string; hud?: string };
          const ack = decodeCarryAck(unb64(answer.ack));
          expect(ack.status).toBe(200);
          expect(verifyCarryAck(unb64(carry.ack_pk), envelope, ack)).toBe(true);
          if (answer.hud) g.takeHud(answer.hud);
        } else await g.request("POST", "/batch", body);
        mine.push(sealed);
      }
      if (k === 5) {
        // The bystander's first batch again: the referee already has seq 0.
        const resent = (sent.get(bystander) as Uint8Array[])[0] as Uint8Array;
        await bystander.request("POST", "/batch", { match_id: id, sealed: b64(resent) });
        // And bytes that are no sealed batch at all.
        await bystander.request("POST", "/batch", { match_id: id, sealed: b64(garbage) });
      }
      await relay.matches.step(id);
      const tick = store.match(id)?.tick_no ?? 0;
      expect(tick).toBe(k);
      // Every HUD opened under the pinned key (Ghost.takeHud), and names a prefix of the relay's log.
      await until(() => ghosts.every((g) => g.huds.at(-1)?.tick === tick), `the HUDs of tick ${tick}`);
      const leaves = store.leaves(id);
      for (const g of ghosts) {
        const hud = g.huds.at(-1);
        expect(hud?.player).toBe(index(g));
        // Every batch it sent took its seq (the carried one, and the one with a simulated fix,
        // which is authentic but invalid); the resend and the garbage did not.
        expect(hud?.nextSeq).toBe(sent.get(g)?.length);
        expect(equal(hud?.root ?? new Uint8Array(), merkleRoot(leaves.slice(0, Number(hud?.logSize))))).toBe(
          true,
        );
      }
    }

    // ── what happened ────────────────────────────────────────────────────────────
    const health = await get<{ referee: Record<string, unknown> }>("/health");
    expect(health.referee).toMatchObject({ kind: "local", status: "up", last_error: null });
    const m = await chain.getMatch(id);
    const vs = store.verdicts(id).map((v) => decodeSignedVerdict(v.raw));
    const kinds = vs.map((v) => v.body.kind);
    expect(m?.phase).toBe("ended");
    expect(m?.seq).toBe(vs.length);
    expect(store.pendingVerdicts(id)).toEqual([]);
    expect(kinds[0]).toBe("Start");
    expect(kinds.at(-1)).toBe("End");
    expect(kinds.filter((x) => x === "Hint" || x === "Tag")).toEqual(["Hint", "Tag"]);
    expect(kinds.filter((x) => x === "Checkpoint").length).toBeGreaterThanOrEqual(1);
    const hintV = vs.find((v) => v.body.kind === "Hint")?.body;
    // The Hint names only its asker: whom it was about comes out at End.
    // The first hint of the match: nothing bought before it, so the base price. Dated by the
    // referee clock inside the match, where the contract checks it.
    const startV = vs[0]?.body;
    expect(hintV).toMatchObject({
      kind: "Hint",
      from: index(hunter),
      amount: hintPrice(STAKE, 0, 0),
      hintId: 0,
      hint: 0,
    });
    if (hintV?.kind !== "Hint" || startV?.kind !== "Start") throw new Error("no Hint or Start");
    expect(hintV.tMs >= startV.startMs && hintV.tMs <= startV.endMs).toBe(true);
    expect(vs.find((v) => v.body.kind === "Tag")?.body).toEqual({
      kind: "Tag",
      hunter: index(hunter),
      target: index(target),
      credit: hintPrice(STAKE, 0, 0),
    });
    const endBody = vs.at(-1)?.body;
    expect(endBody?.kind === "End" && endBody.hintTargets).toEqual([index(target)]);
    // Settled as the contract settles once its replay holds: the hunter paid for the hint, the
    // target was credited it just before its head went to the hunter.
    expect(chain.settlement(id)).toEqual({ settledAs: "payout", violation: null });
    const paid = Object.fromEntries(m?.players.map((p) => [p.account_id, BigInt(p.paid)]) ?? []);
    expect(paid).toEqual({
      [hunter.accountId]: 2n * STAKE,
      [target.accountId]: 0n,
      [bystander.accountId]: STAKE,
    });
    expect(target.out).toBe(true);
    expect(target.huds.at(-1)?.taggedBy).toBe(hunter.accountId);

    // Refusals and rejections arrive as the protocol's numeric codes, from the referee to the phone.
    const ticks = store.ticks(id);
    expect(ticks.flatMap((t) => t.refused)).toContainEqual({
      player: index(hunter),
      nonce: 1,
      action: "strike",
      reason: RefuseCode.Lock,
    });
    const rejected = ticks.flatMap((t) => t.rejected);
    expect(rejected).toEqual([
      { player: index(bystander), seq: flagged?.seq, reason: RejectCode.FixFlags },
      { player: index(bystander), seq: 0, reason: RejectCode.Seq },
    ]);
    expect(bystander.rejections.map((r) => r["detail"])).toEqual(rejected);

    // The signed HUD names only the authentic rejected batch: anyone can replay an old batch
    // (the Seq one), and the HUD does not repeat what it cannot attribute to the phone. The
    // bytes that were no batch never opened, and after End the referee refused just those when
    // the relay asked for the trails.
    const named = bystander.huds.flatMap((h) => (h.rejected ? [h.rejected] : []));
    expect(new Set(named.map((r) => JSON.stringify(r)))).toEqual(
      new Set([JSON.stringify({ seq: flagged?.seq, code: RejectCode.FixFlags })]),
    );
    const tick5 = answers.filter((a) => a.cmd === "tick")[4]?.result;
    expect(tick5?.["unopened"]).toEqual([{ index: expect.any(Number), reason: expect.any(String) }]);
    const trailsAnswer = answers.find((a) => a.cmd === "declassify_batches")?.result;
    const allSent = store.allBatches(id).map((x) => toHex(x.sealed));
    expect(trailsAnswer?.["refused"]).toEqual([
      { index: allSent.indexOf(toHex(garbage)), reason: expect.any(String) },
    ]);
    // The hint's fact reached the asker's HUD too.
    expect(hunter.huds.some((h) => h.hintFact)).toBe(true);

    // The Handler: a template line (no NEAR AI key, so no model signature), sealed and signed to the
    // asker alone. The answer says nothing else: not the line, not where it came from or why.
    const voiced = answers.filter((a) => a.cmd === "voice").map((a) => a.result);
    expect(voiced).toHaveLength(1);
    expect(Object.keys(voiced[0] ?? {}).sort()).toEqual([
      "hint_id",
      "player",
      "receipt",
      "sealed",
      "signed_text",
    ]);
    expect(voiced[0]).toMatchObject({ signed_text: null, player: index(hunter) });
    expect(hunter.handlerLines).toEqual(["They're within 150 metres. Look sharp."]);
    expect([...target.handlerLines, ...bystander.handlerLines]).toEqual([]);

    // ── the replay ───────────────────────────────────────────────────────────────
    const bundle = await get<ReplayBundleV2>(`/replay/${id}`);
    expect(bundle.version).toBe(2);
    expect(bundle.referee.kind).toBe("local");
    const log = bundle.log.map((e) => decodeLogEntry(unb64(e)));
    expect(log.map((e) => toHex(merkleLeaf(e)))).toEqual(bundle.leaves);
    expect(store.leaves(id).map(toHex)).toEqual(bundle.leaves);
    const end = vs.at(-1)?.body;
    if (end?.kind !== "End") throw new Error("the last verdict is not End");
    expect(log.length).toBe(Number(end.logSize) + 1);

    // The web verifier, against what the chain holds.
    const roots = await chain.getRoots(id);
    const onChain: ChainState = {
      kind: "found",
      match: {
        match_id: id,
        token: m?.token ?? "",
        stake: m?.stake ?? "",
        phase: m?.phase ?? "lobby",
        players: m?.players ?? [],
        sponsors: [],
        seq: m?.seq ?? 0,
        referee_pk: m?.referee_pk ?? "",
        vrf_pk: m?.vrf_pk ?? "",
        ring_commit: m?.ring_commit ?? null,
        start_ms: m?.start_ms ?? null,
        end_ms: m?.end_ms ?? null,
        alpha: m?.alpha ?? null,
        vrf_signature: m?.vrf_signature ?? null,
        public_replay: m?.public_replay ?? false,
      },
      roots,
      head: { kind: "found", digest: chain.head(id) as Uint8Array, seq: m?.seq ?? null },
    };
    const d = decodeBundle(bundle);
    const web = verifyAll(d, onChain, { contract: CONTRACT, network: "testnet", matchId: id });
    expect(web.binding).toEqual({ ok: true });
    expect(web.statuses).toEqual(vs.map(() => "verified"));
    expect(web.level).toEqual({ identity: true, complete: true, payouts: true, ended: true });
    expect(web.verdictChain).toMatchObject({ kind: "checked", breakAt: null, onNear: "match" });
    expect(web.consistency.source).toBe("near");
    expect(web.consistency.ok).toBe(true);
    expect(web.consistency.links).toHaveLength(roots.checkpoints.length);
    expect(web.salts).toMatchObject({ kind: "checked", bad: [] });
    expect(web.batches.failed).toEqual([]);
    // The batch after the rejected one links to a batch the log holds only as Rejected, so the
    // page cannot check that one link; every other batch's link holds.
    expect(web.batches.inLog.size).toBe(d.batches.length);
    expect([...web.batches.unchecked]).toEqual([`${index(bystander)}:${(flagged?.seq ?? 0) + 1}`]);
    expect(web.enrolled).toEqual(ghosts.map(() => ({ attested: false, sameAccount: true })));
    const receipt = log.find((e) => e.kind === "HintReceipt");
    expect(receipt?.kind === "HintReceipt" && receipt.signature.length).toBe(0);
    expect(bundle.handler).toEqual([
      { hintId: hintV?.kind === "Hint" ? hintV.hintId : -1, signedText: null },
    ]);
    expect([...web.handler.values()].map((h) => h.signature)).toEqual(["unsigned"]);

    // The same checks, spelled out with @tail/protocol.
    expect(verdictChainBreak(vs, pins.refereePk)).toBeUndefined();
    const kM = fromHex(bundle.reveal.kM);
    expect(log.filter((e) => logEntrySalt(e)).length).toBeGreaterThan(0);
    expect(badLogSalts(kM, log)).toEqual([]);
    // Every anchored root extends every earlier one, by the relay's consistency proofs.
    const anchors = [
      { size: 0, root: merkleEmptyRoot() },
      ...[...roots.checkpoints, roots.final_root as { log_size: number; root: string }].map((r) => ({
        size: r.log_size,
        root: fromHex(r.root),
      })),
    ];
    for (const [i, a] of anchors.entries())
      for (const b of anchors.slice(i + 1)) {
        const p = await get<{ path: string[] }>(`/matches/${id}/consistency?from=${a.size}&to=${b.size}`);
        expect(verifyConsistency(a.size, b.size, a.root, b.root, p.path.map(fromHex))).toBe(true);
      }
    // The Tag's evidence sits right before it: enough logged contact epochs between the two.
    const tagAt = log.findIndex(
      (e) => e.kind === "Verdict" && vs.find((v) => v.seq === e.seq)?.body.kind === "Tag",
    );
    const ev = log[tagAt - 1];
    expect(ev).toMatchObject({ kind: "Evidence", hunter: index(hunter), target: index(target) });
    const pair = [index(hunter), index(target)].sort((x, y) => x - y);
    const epochs = ev?.kind === "Evidence" ? ev.epochs : [];
    expect(epochs.length).toBeGreaterThanOrEqual(LOCK_EPOCHS);
    for (const e of epochs)
      expect(
        log.some((c) => c.kind === "Contact" && c.epoch === e && c.a === pair[0] && c.b === pair[1]),
      ).toBe(true);
    // Every leaf under every anchored root, proved by the relay's inclusion endpoint.
    for (const a of anchors.slice(1)) {
      for (let i = 0; i < a.size; i++) {
        const leaf = bundle.leaves[i] as string;
        const inc = await get<{ index: number; path: string[] }>(
          `/matches/${id}/inclusion?leaf=${leaf}&size=${a.size}`,
        );
        expect(inc.index).toBe(i);
        expect(merkleVerify(fromHex(leaf), inc.index, a.size, inc.path.map(fromHex), a.root)).toBe(true);
      }
    }

    // The trails: every batch the referee accepted, the carried one included, and nothing else.
    const logged = log.flatMap((e) => (e.kind === "Batch" ? [e] : []));
    const uploads = [...sent.values()].reduce((n, x) => n + x.length, 0);
    expect(logged).toHaveLength(uploads - 1);
    expect(bundle.batches.map((b) => toHex(sha256(unb64(b)))).sort()).toEqual(
      logged.map((e) => toHex(e.hash)).sort(),
    );
    expect(logged.some((e) => e.player === carried?.player && e.seq === carried.seq)).toBe(true);
    expect(log.filter((e) => e.kind === "Rejected")).toEqual([
      expect.objectContaining({ player: index(bystander), seq: flagged?.seq, code: RejectCode.FixFlags }),
      expect.objectContaining({ player: index(bystander), seq: 0, code: RejectCode.Seq }),
    ]);
    // The phone's next batch chains to the rejected one, whose hash the log keeps.
    const rejectedEntry = log.find((e) => e.kind === "Rejected" && e.seq === flagged?.seq);
    const next = d.batches.find(
      (x) => x.batch?.player === index(bystander) && x.batch.seq === (flagged?.seq ?? 0) + 1,
    );
    expect(rejectedEntry?.kind === "Rejected" && toHex(rejectedEntry.hash)).toBe(
      toHex(next?.batch?.prev ?? new Uint8Array()),
    );
  }, 60_000);
});
