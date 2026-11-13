import { describe, expect, test } from "bun:test";
import { DEFAULT_RPC, readSettings, storedSettings } from "./settings";

const build = { relayUrl: "http://192.168.1.20:8787", rpcUrl: DEFAULT_RPC };

describe("settings", () => {
  test("an older build's file keeps its relay address and mesh switch; its contract and replay site are dropped", () => {
    const old = JSON.stringify({
      relayUrl: "http://10.0.0.7:8787/",
      replayUrl: "https://replay.example",
      rpcUrl: "https://test.rpc.fastnear.com",
      contractId: "tail.someone-else.testnet",
      meshCarry: true,
    });
    expect(readSettings(old, build)).toEqual({
      relayUrl: "http://10.0.0.7:8787",
      rpcUrl: DEFAULT_RPC,
      meshCarry: true,
    });
  });

  test("with no file, or an empty address, the build's addresses apply; with neither, the relay is unset", () => {
    expect(readSettings(null, build)).toEqual({ ...build, meshCarry: false });
    expect(readSettings(JSON.stringify({ relayUrl: " ", rpcUrl: "" }), build).relayUrl).toBe(build.relayUrl);
    expect(readSettings(null, { ...build, relayUrl: "" }).relayUrl).toBe("");
  });

  test("the file holds only what the player changed, so a new build's default reaches everyone else", () => {
    const same = storedSettings({ ...build, meshCarry: false }, build);
    expect(JSON.parse(same)).toEqual({ relayUrl: "", rpcUrl: "", meshCarry: false });
    const newBuild = { ...build, relayUrl: "https://relay.example" };
    expect(readSettings(same, newBuild).relayUrl).toBe("https://relay.example");
    const typed = storedSettings({ ...build, relayUrl: "http://10.0.0.7:8787/", meshCarry: true }, build);
    expect(readSettings(typed, newBuild)).toEqual({
      relayUrl: "http://10.0.0.7:8787",
      rpcUrl: DEFAULT_RPC,
      meshCarry: true,
    });
  });
});
