// What the relay sends the referee's `enroll`, over both transports: a phone's attestation and
// challenge as base64, none for a ghost, and the local referee process gets ALLOW_UNATTESTED only
// when the relay allows ghosts. The referee's `attested` answer is read back.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefuseCode, RejectCode } from "@tail/protocol";
import { LocalReferee, OutLayerReferee, refuseName, rejectName } from "../src/referee.ts";

const ANSWER = {
  ok: true,
  result: {
    call_id: "c1",
    account_id: "ana.relay.testnet",
    app_attest_pk: Buffer.alloc(65, 4).toString("base64"),
    receipt: Buffer.alloc(8).toString("base64"),
    sig: Buffer.alloc(64).toString("base64"),
    attested: true,
  },
};
const PHONE = {
  accountId: "ana.relay.testnet",
  appAttestPk: new Uint8Array(65).fill(4),
  playerBoxPk: new Uint8Array(32).fill(1),
  nearPk: new Uint8Array(32).fill(2),
  attestation: new Uint8Array([0xa3, 1, 2, 3]),
  challenge: new Uint8Array(32).fill(7),
};

/** A stand-in for the native referee: records its stdin and environment, answers ANSWER. */
function fakeBin() {
  const dir = mkdtempSync(join(tmpdir(), "tail-referee-"));
  const bin = join(dir, "tail-referee");
  writeFileSync(
    bin,
    `#!/bin/sh\ncat > "$TAIL_LOCAL_REFEREE_DIR/stdin.json"\necho "\${ALLOW_UNATTESTED:-unset}" > "$TAIL_LOCAL_REFEREE_DIR/env.txt"\necho "\${NEARAI_API_KEY:-unset} \${NEARAI_MODEL:-unset}" > "$TAIL_LOCAL_REFEREE_DIR/nearai.txt"\necho '${JSON.stringify(ANSWER)}'\n`,
  );
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    input: () => JSON.parse(readFileSync(join(dir, "stdin.json"), "utf8")) as Record<string, unknown>,
    unattested: () => readFileSync(join(dir, "env.txt"), "utf8").trim(),
    nearai: () => readFileSync(join(dir, "nearai.txt"), "utf8").trim(),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("referee enroll", () => {
  test("the local referee gets the phone's attestation and challenge, and no ALLOW_UNATTESTED", async () => {
    const f = fakeBin();
    try {
      const r = new LocalReferee({ bin: f.bin, dir: f.dir, owner: "relay.testnet", allowUnattested: false });
      const out = await r.enroll(PHONE);
      expect(out.attested).toBe(true);
      const input = f.input();
      expect(input["cmd"]).toBe("enroll");
      expect(input["attestation"]).toBe(Buffer.from(PHONE.attestation).toString("base64"));
      expect(input["challenge"]).toBe(Buffer.from(PHONE.challenge).toString("base64"));
      expect(f.unattested()).toBe("unset");
      expect(f.nearai()).toBe("unset unset");
    } finally {
      f.done();
    }
  });

  test("the local referee gets NEARAI_API_KEY and NEARAI_MODEL when the relay has them, for `voice`", async () => {
    const f = fakeBin();
    try {
      const r = new LocalReferee({
        bin: f.bin,
        dir: f.dir,
        owner: "relay.testnet",
        allowUnattested: false,
        nearaiApiKey: "sk-test",
        nearaiModel: "zai-org/GLM-5",
      });
      await r.enroll(PHONE);
      expect(f.nearai()).toBe("sk-test zai-org/GLM-5");
    } finally {
      f.done();
    }
  });

  test("with ghosts allowed the local referee runs with ALLOW_UNATTESTED=1; a ghost sends no attestation", async () => {
    const f = fakeBin();
    try {
      const r = new LocalReferee({ bin: f.bin, dir: f.dir, owner: "relay.testnet", allowUnattested: true });
      const { attestation: _a, challenge: _c, ...ghost } = PHONE;
      await r.enroll(ghost);
      expect(f.unattested()).toBe("1");
      expect(Object.keys(f.input())).not.toContain("attestation");
      expect(Object.keys(f.input())).not.toContain("challenge");
    } finally {
      f.done();
    }
  });

  test("OutLayer gets the same input, and an answer without `attested` reads as unknown", async () => {
    let sent: Record<string, unknown> = {};
    const { attested: _x, ...older } = ANSWER.result;
    const r = new OutLayerReferee({
      api: "https://testnet-api.outlayer.ai",
      owner: "o.testnet",
      project: "tail-referee",
      paymentKey: "k",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = (JSON.parse(String(init.body)) as { input: Record<string, unknown> }).input;
        return new Response(JSON.stringify({ output: { ok: true, result: older }, call_id: "c1" }));
      }) as unknown as typeof fetch,
    });
    const out = await r.enroll(PHONE);
    expect(sent["attestation"]).toBe(Buffer.from(PHONE.attestation).toString("base64"));
    expect(sent["challenge"]).toBe(Buffer.from(PHONE.challenge).toString("base64"));
    expect(out.attested).toBeNull();
  });
});

describe("refusal codes", () => {
  test("the relay names every protocol code in its logs, and says an unknown one is a code", () => {
    expect(refuseName(RefuseCode.Funds)).toBe("Funds");
    expect(rejectName(RejectCode.TooOld)).toBe("TooOld");
    for (const c of Object.values(RefuseCode)) expect(refuseName(c)).not.toStartWith("code");
    expect(refuseName(99)).toBe("code 99");
  });
});
