import { describe, expect, test } from "bun:test";
import { ConfigError, describeConfig, loadConfig } from "../src/config.ts";

const good = {
  NEAR_NETWORK: "testnet",
  NEAR_RELAY_ACCOUNT: "relay-x.testnet",
  NEAR_RELAY_PRIVATE_KEY: "ed25519:4ab1cdEFsecretsecretsecret",
  TAIL_CONTRACT: "tail.relay-x.testnet",
  OUTLAYER_API: "https://testnet-api.outlayer.ai",
  OUTLAYER_OWNER: "relay-x.testnet",
  REFEREE_PAYMENT_KEY: "relay-x.testnet:1:paymentsecret",
  APPLE_TEAM_ID: "TEAM123456",
  IOS_BUNDLE_ID: "com.example.tail",
};

describe("loadConfig", () => {
  test("a complete testnet environment loads", () => {
    const c = loadConfig(good);
    expect(c.appId).toBe("TEAM123456.com.example.tail");
    expect(c.allowGhosts).toBe(false);
    expect(c.token).toBe("usdc.fakes.testnet");
  });

  test("a value still holding the .env.example placeholder is refused", () => {
    expect(() => loadConfig({ ...good, NEAR_RELAY_PRIVATE_KEY: "ed25519:PLACEHOLDER" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, OUTLAYER_OWNER: "your-account.testnet" })).toThrow("placeholder");
  });

  test("mainnet is refused", () => {
    expect(() => loadConfig({ ...good, NEAR_NETWORK: "mainnet" })).toThrow("testnet");
    expect(() => loadConfig({ ...good, TAIL_CONTRACT: "tail.near" })).toThrow("testnet");
  });

  test("ghosts are allowed only with ALLOW_GHOSTS=1", () => {
    expect(loadConfig({ ...good, ALLOW_GHOSTS: "0" }).allowGhosts).toBe(false);
    expect(loadConfig({ ...good, ALLOW_GHOSTS: "1" }).allowGhosts).toBe(true);
    expect(() => loadConfig({ ...good, ALLOW_GHOSTS: "yes" })).toThrow("ALLOW_GHOSTS");
  });

  test("the printable description holds no key", () => {
    const text = JSON.stringify(describeConfig(loadConfig(good)));
    expect(text).not.toContain("secret");
    expect(text).toContain("present");
  });
});
