import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExpoConfig } from "expo/config";

// The team id, bundle id and contract live in the repo-root env files (see /.env.example).
// Expo only loads env files from this folder, so read the root ones here. Values already in the
// shell win, then .env.local, then .env. Only these public names are read: everything in
// `extra` is bundled into the app, so no secret may ever be added to PUBLIC.
const PUBLIC = ["APPLE_TEAM_ID", "IOS_BUNDLE_ID", "TAIL_CONTRACT", "NEAR_NETWORK"] as const;

function rootEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [".env.local", ".env"]) {
    const path = resolve(__dirname, "..", "..", name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m?.[1] || line.trimStart().startsWith("#") || !(PUBLIC as readonly string[]).includes(m[1]))
        continue;
      out[m[1]] ??= (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return out;
}

const file = rootEnv();
const env = (k: (typeof PUBLIC)[number]) => {
  const v = process.env[k] ?? file[k];
  return v && !/PLACEHOLDER|your-account/.test(v) ? v : undefined;
};

const teamId = env("APPLE_TEAM_ID");
// A bundle id is needed even for a simulator compile check. Without IOS_BUNDLE_ID an obviously
// unregistered one is used; signing for a phone then fails until it is set.
const bundleId = env("IOS_BUNDLE_ID") ?? "invalid.placeholder.tail";

const config: ExpoConfig = {
  name: "TAIL",
  slug: "tail",
  scheme: "tail",
  version: "0.1.0",
  orientation: "portrait",
  // The Trail mark app icon, from the brand package (the single source; not copied here).
  icon: "../../packages/brand/assets/app-icon-1024.png",
  userInterfaceStyle: "light",
  platforms: ["ios"],
  ios: {
    bundleIdentifier: bundleId,
    ...(teamId ? { appleTeamId: teamId } : {}),
    supportsTablet: false,
    infoPlist: {
      NSBluetoothAlwaysUsageDescription:
        "TAIL trades secret codes with nearby players' phones over Bluetooth.",
      NSLocationWhenInUseUsageDescription: "TAIL sends your position, sealed, to the match referee.",
      NSLocalNetworkUsageDescription: "TAIL talks to a relay on your local network during development.",
      // A development relay is plain http on the LAN; everything else must be https.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      // TAIL is foreground-only. These modes are here only because the Offline Protocol SDK
      // creates its Bluetooth managers with state restoration, and iOS terminates an app that
      // does that without declaring them (spikes/device). tail-radio does not rely on them.
      UIBackgroundModes: ["bluetooth-central", "bluetooth-peripheral"],
    },
    entitlements: {
      // Development App Attest keys (Apple answers with the "appattestdevelop" AAGUID). The
      // relay's APP_ATTEST_ENV must match.
      "com.apple.developer.devicecheck.appattest-environment": "development",
    },
  },
  plugins: ["expo-dev-client"],
  extra: {
    contractId: env("TAIL_CONTRACT") ?? null,
    nearNetwork: env("NEAR_NETWORK") ?? "testnet",
  },
};

export default config;
