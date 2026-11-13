// Every secret field the code base names is redacted, at the top level and nested, and a field
// that is not a secret still prints.

import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/index.ts";

function logged(obj: Record<string, unknown>): string {
  let out = "";
  const log = createLogger("redact-test", { write: (s: string) => (out += s) });
  log.info(obj, "line");
  return out;
}

describe("the logger", () => {
  const secret = "s3cr3t-value-123";
  const fields = [
    "privateKey",
    "relayPrivateKey",
    "refereePaymentKey",
    "outlayerPaymentKey",
    "paymentKey",
    "nearSeed",
    "secretKey",
    "seed",
    "boxSk",
    "attestSk",
    "apiKey",
    "authorization",
    "NEAR_RELAY_PRIVATE_KEY",
    "REFEREE_PAYMENT_KEY",
    "OUTLAYER_PAYMENT_KEY",
  ];

  for (const f of fields) {
    test(`redacts ${f} at the top, one and two levels down`, () => {
      const out = logged({ [f]: secret, config: { [f]: secret }, req: { inner: { [f]: secret } } });
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    });
  }

  test("redacts a payment key header", () => {
    expect(logged({ req: { headers: { "x-payment-key": secret } } })).not.toContain(secret);
  });

  test("keeps fields that are not secrets", () => {
    const out = logged({ accountId: "ana.testnet", relayKey: "present, 88 chars" });
    expect(out).toContain("ana.testnet");
    expect(out).toContain("present, 88 chars");
  });
});
