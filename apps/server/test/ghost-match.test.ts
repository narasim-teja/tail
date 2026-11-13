// Three ghosts play a whole match through the relay's real HTTP and WebSocket API, against the
// fake chain and referee: v2-signed requests, PlayerKeys and HUDs checked against the pinned
// referee key, real sealed batches (one delivered over the mesh by another ghost), a hint whose
// Handler line reaches only the asker, and a version 2 replay whose leaves, declassified log,
// trails and proofs all check out against the roots the chain anchored.

import { describe, expect, test } from "bun:test";
import {
  decodeCarryAck,
  decodeLogEntry,
  fromHex,
  merkleLeaf,
  merkleRoot,
  merkleVerify,
  type ReplayBundleV2,
  sha256,
  toHex,
  verifyCarryAck,
} from "@tail/protocol";
import { Ghost } from "../src/ghosts/ghost.ts";
import { until } from "./fakes.ts";
import { CONTRACT, ended, MATCH, serve, setup } from "./harness.ts";

const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

describe("a ghost match", () => {
  test("three ghosts play to the end and the replay verifies", async () => {
    const env = setup({ allowGhosts: true });
    env.referee.hintAtTick = 0;
    env.referee.checkpointAtTick = 3;
    env.referee.overAt = 1_000_000;
    const url = serve(env);
    const trust = { contract: CONTRACT, refereePk: env.referee.pk };
    const ghosts = ["a", "b", "c"].map((r) => new Ghost(`ghost-${r}`, url, trust));
    for (const g of ghosts) await g.enroll(env.enrolment);
    const [host] = ghosts as [Ghost];
    const { match_id: id } = await host.request<{ match_id: string }>("POST", "/matches", {
      ...MATCH,
      start_by_ms: Date.now() + 600_000,
    });
    for (const g of ghosts) {
      env.chain.balances.set(g.accountId, BigInt(MATCH.stake));
      await env.chain.joinAsGhost(g.accountId, g.nearSeed, id);
    }
    const started = await host.request<{ keys: { account_id: string; sealed: string }[] }>(
      "POST",
      `/matches/${id}/start`,
      {},
    );
    // Start hands the host only its own keys; every other player fetches its own.
    expect(started.keys.map((k) => k.account_id)).toEqual([host.accountId]);
    for (const g of ghosts) await g.fetchKeys(id);
    for (const g of ghosts) await g.connectHud(id);
    const byPlayer = [...ghosts].sort((x, y) => (x.keys?.player ?? 0) - (y.keys?.player ?? 0));
    const [hunter, target, bystander] = byPlayer as [Ghost, Ghost, Ghost];

    const { refereeBoxPk } = await env.referee.pubkeys();
    const carryKey = await (await fetch(`${url}/carry/key`)).json();
    const relayBoxPk = unb64(String((carryKey as { box_pk: string }).box_pk));
    hunter.hint(0, "close?");
    const sent: Uint8Array[] = [];
    for (let round = 0; round < 2; round++) {
      for (const g of byPlayer) {
        const batch = g.sealedBatch(Date.now(), refereeBoxPk, "TEAM.app");
        sent.push(batch);
        const body = { match_id: id, sealed: Buffer.from(batch).toString("base64") };
        if (g === bystander && round === 1) {
          // The bystander has no signal: the target carries its batch to the relay.
          const envelope = g.carried("POST", "/batch", body, relayBoxPk);
          const res = await fetch(`${url}/carry`, { method: "POST", body: envelope });
          const ack = decodeCarryAck(unb64(String(((await res.json()) as { ack: string }).ack)));
          const ackPk = unb64(String((carryKey as { ack_pk: string }).ack_pk));
          expect(ack.status).toBe(200);
          expect(verifyCarryAck(ackPk, envelope, ack)).toBe(true);
        } else await g.request("POST", "/batch", body);
      }
      await until(() => [0, 1, 2].every((p) => env.store.queuedCount(id, p) === 0), "a tick");
    }
    await until(() => hunter.handlerLines.length, "the hunter's Handler line");
    env.referee.overAt = 0;
    await ended(env, id);

    // The Handler answered the hunter, and nobody else heard it.
    expect(hunter.handlerLines).toEqual(["line for hint 0"]);
    expect(target.handlerLines).toEqual([]);
    expect(bystander.handlerLines).toEqual([]);
    // Every HUD a ghost kept opened under the referee's signature.
    for (const g of ghosts) expect(g.huds.length).toBeGreaterThan(0);

    const kinds = env.store.verdicts(id).map((v) => v.kind);
    // The Checkpoint lands at tick 3, the hint whenever its batch's tick runs.
    expect([...kinds].sort()).toEqual(["Checkpoint", "End", "Hint", "Start"]);
    expect([kinds[0], kinds.at(-1)]).toEqual(["Start", "End"]);
    const roots = await env.chain.getRoots(id);
    const final = roots.final_root as { log_size: number; root: string };

    const bundle = (await (await fetch(`${url}/replay/${id}`)).json()) as ReplayBundleV2;
    expect(bundle.version).toBe(2);
    const log = bundle.log.map((e) => decodeLogEntry(unb64(e)));
    expect(log.map((e) => toHex(merkleLeaf(e)))).toEqual(bundle.leaves);
    expect(toHex(merkleRoot(bundle.leaves.slice(0, final.log_size).map(fromHex)))).toBe(final.root);
    // Each ghost's batches are logged as themselves, and the trails are exactly those batches.
    const logged = log.flatMap((e) => (e.kind === "Batch" ? [toHex(e.hash)] : []));
    expect(logged).toHaveLength(sent.length);
    expect(bundle.batches.map((b) => toHex(sha256(unb64(b)))).sort()).toEqual([...logged].sort());
    expect(bundle.handler).toEqual([{ hintId: 0, signedText: expect.stringMatching(/^fake-model:/) }]);
    expect(bundle.devices.every((d) => d.kind === "ghost" && d.attested === false)).toBe(true);

    // The carried batch is in the log, and the relay proves it under the anchored root.
    const carried = log.findIndex(
      (e) => e.kind === "Batch" && e.player === bystander.keys?.player && e.seq === 1,
    );
    const leaf = bundle.leaves[carried] as string;
    const inc = (await (
      await fetch(`${url}/matches/${id}/inclusion?leaf=${leaf}&size=${final.log_size}`)
    ).json()) as {
      index: number;
      path: string[];
    };
    expect(
      merkleVerify(fromHex(leaf), inc.index, final.log_size, inc.path.map(fromHex), fromHex(final.root)),
    ).toBe(true);
    for (const g of ghosts) g.closeHud();
  }, 20_000);
});
