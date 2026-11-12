import { type NativeModule, requireNativeModule } from "expo";

export interface RadioSighting {
  /** 128-bit service UUID, upper case, as CoreBluetooth prints it. */
  uuid: string;
  /** dBm; 127 means CoreBluetooth had no reading for the packet. */
  rssi: number;
  tMs: number;
}

export interface RadioFix {
  /** Fix timestamp from CoreLocation, unix ms. */
  tMs: number;
  lat: number;
  lon: number;
  /** Horizontal accuracy in metres; negative means invalid. */
  acc: number;
  /** m/s; negative means invalid. */
  speed: number;
  /** Direction of travel, degrees clockwise from true north; negative means unknown. */
  course: number;
  /** CLLocationSourceInformation.isSimulatedBySoftware; null when iOS reports nothing. */
  simulated: boolean | null;
  /** CLLocationSourceInformation.isProducedByAccessory; null when iOS reports nothing. */
  accessory: boolean | null;
}

export type AppState = "active" | "inactive" | "background" | "unknown";
export interface AppStateEvent {
  state: AppState;
  event: string;
  tMs: number;
}
export interface ProximityEvent {
  near: boolean;
  pocketMode?: boolean;
  proximitySupported?: boolean;
  tMs: number;
}
export interface RadioStateEvent {
  role: "peripheral" | "central";
  state: string;
  advertising?: boolean;
  scanning?: boolean;
  error?: string | null;
  tMs: number;
}
export interface LocationStateEvent {
  status: string;
  fullAccuracy: boolean;
  error?: string | null;
  tMs: number;
}

type Events = {
  onSighting(e: RadioSighting): void;
  onFix(e: RadioFix): void;
  onAppState(e: AppStateEvent): void;
  onProximity(e: ProximityEvent): void;
  onRadioState(e: RadioStateEvent): void;
  onLocationState(e: LocationStateEvent): void;
};

declare class TailRadioModule extends NativeModule<Events> {
  startBeacon(): void;
  setToken(uuid: string): void;
  stopBeacon(): void;
  /** 4-byte tag prefixes (8 hex chars each); only UUIDs starting with one are reported. */
  setScanFilter(prefixes: string[]): void;
  startScan(): void;
  stopScan(): void;
  startLocation(): void;
  stopLocation(): void;
  setPocketMode(on: boolean): void;
  getAppState(): AppState;
}

export default requireNativeModule<TailRadioModule>("TailRadio");
