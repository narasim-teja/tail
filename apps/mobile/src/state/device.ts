// Adapters from the native modules to the session's ports.
import TailAttest from "../../modules/tail-attest";
import TailRadio from "../../modules/tail-radio";
import type { Assert } from "../game/batch";
import type { RadioPort } from "../game/session";
import { fromB64, toB64 } from "../lib/b64";

export const radioPort: RadioPort = {
  startBeacon: () => TailRadio.startBeacon(),
  setToken: (u) => TailRadio.setToken(u),
  stopBeacon: () => TailRadio.stopBeacon(),
  setScanFilter: (p) => TailRadio.setScanFilter(p),
  startScan: () => TailRadio.startScan(),
  stopScan: () => TailRadio.stopScan(),
  startLocation: () => TailRadio.startLocation(),
  stopLocation: () => TailRadio.stopLocation(),
  setPocketMode: (on) => TailRadio.setPocketMode(on),
  onSighting: (fn) => {
    const sub = TailRadio.addListener("onSighting", fn);
    return () => sub.remove();
  },
  onFix: (fn) => {
    const sub = TailRadio.addListener("onFix", fn);
    return () => sub.remove();
  },
  onRadioState: (fn) => {
    const sub = TailRadio.addListener("onRadioState", (e) => fn(e.role, e.state));
    return () => sub.remove();
  },
  onLocationState: (fn) => {
    const sub = TailRadio.addListener("onLocationState", fn);
    return () => sub.remove();
  },
  onAppState: (fn) => {
    const sub = TailRadio.addListener("onAppState", fn);
    return () => sub.remove();
  },
  onProximity: (fn) => {
    const sub = TailRadio.addListener("onProximity", fn);
    return () => sub.remove();
  },
};

export const attestor = TailAttest;

export const assertWith =
  (keyId: string): Assert =>
  async (cdh) =>
    fromB64(await TailAttest.generateAssertion(keyId, toB64(cdh)));
