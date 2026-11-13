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

  test("private trails are kept 24 h after End unless RELAY_RETENTION_HOURS says otherwise", () => {
    expect(loadConfig(good).retentionMs).toBe(24 * 3_600_000);
    expect(loadConfig({ ...good, RELAY_RETENTION_HOURS: "6" }).retentionMs).toBe(6 * 3_600_000);
    for (const bad of ["0", "1.5", "forever"])
      expect(() => loadConfig({ ...good, RELAY_RETENTION_HOURS: bad })).toThrow("RELAY_RETENTION_HOURS");
  });

  test("ghosts are allowed only with ALLOW_GHOSTS=1", () => {
    expect(loadConfig({ ...good, ALLOW_GHOSTS: "0" }).allowGhosts).toBe(false);
    expect(loadConfig({ ...good, ALLOW_GHOSTS: "1" }).allowGhosts).toBe(true);
    expect(() => loadConfig({ ...good, ALLOW_GHOSTS: "yes" })).toThrow("ALLOW_GHOSTS");
  });

  test("the referee is OutLayer unless REFEREE_MODE=local; both play on TAIL_CONTRACT", () => {
    const outlayer = loadConfig(good);
    expect(outlayer.refereeMode).toBe("outlayer");
    expect(outlayer.localReferee).toBeNull();
    const local = loadConfig({ ...good, REFEREE_MODE: "local" });
    expect(local.contract).toBe(good.TAIL_CONTRACT);
    expect(local.dbPath).toBe(outlayer.dbPath);
    expect(local.localReferee?.bin).toEndWith("crates/referee-wasi/target/release/tail-referee");
    expect(describeConfig(local).referee).toBe("local test referee (not an enclave)");
    // The VRF alpha names the referee's caller: the OutLayer project owner, or the relay itself.
    expect(outlayer.vrfSender).toBe(good.OUTLAYER_OWNER);
    expect(loadConfig({ ...good, OUTLAYER_OWNER: "owner-y.testnet", REFEREE_MODE: "local" }).vrfSender).toBe(
      good.NEAR_RELAY_ACCOUNT,
    );
    expect(() => loadConfig({ ...good, REFEREE_MODE: "enclave" })).toThrow("REFEREE_MODE");
  });

  test("RELAY_REPLAY_URL is optional and must be an http(s) address the phone can append to", () => {
    expect(loadConfig(good).replayUrl).toBeUndefined();
    expect(loadConfig({ ...good, RELAY_REPLAY_URL: "" }).replayUrl).toBeUndefined();
    for (const ok of [
      "https://replay.example",
      "http://192.168.1.20:5173",
      "https://example.com/tail/replay",
    ])
      expect(loadConfig({ ...good, RELAY_REPLAY_URL: ok }).replayUrl).toBe(ok);
    for (const bad of [
      "https://replay.example/",
      "replay.example",
      "javascript:alert(1)",
      "ftp://replay.example",
      "https://replay.example/?match=1",
      "https://replay.example#x",
    ])
      expect(() => loadConfig({ ...good, RELAY_REPLAY_URL: bad })).toThrow("RELAY_REPLAY_URL");
  });

  test("the printable description holds no key", () => {
    const text = JSON.stringify(describeConfig(loadConfig(good)));
    expect(text).not.toContain("secret");
    expect(text).toContain("present");
  });
});
