import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExpoConfig } from "expo/config";
import { colors } from "../../packages/brand/src/index.ts";

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

const ARCHIVO = ["400Regular", "500Medium", "600SemiBold", "700Bold", "800ExtraBold", "900Black"];
const SPLASH_MARK = "../../packages/brand/assets/splash-mark-512.png";

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
      // Shown when a player chose approximate location: tail-radio asks for precise location for
      // the session under this purpose key (TailRadioModule.swift fullAccuracyPurposeKey).
      NSLocationTemporaryUsageDescriptionDictionary: {
        TailHunt: "The referee checks a tag to a few metres, so the hunt needs your precise location.",
      },
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
  plugins: [
    "expo-dev-client",
    // Archivo, the one family shared with the replay, embedded at build time so text never
    // renders in a fallback face. Addressed by PostScript name in src/ui/theme.ts.
    [
      "expo-font",
      { fonts: ARCHIVO.map((w) => `node_modules/@expo-google-fonts/archivo/${w}/Archivo_${w}.ttf`) },
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: colors.paper,
        // The Trail mark on paper. It comes from the brand package; until the brand build writes
        // SPLASH_MARK the splash is the paper colour alone.
        ...(existsSync(resolve(__dirname, SPLASH_MARK))
          ? { image: SPLASH_MARK, imageWidth: 120, resizeMode: "contain" }
          : {}),
      },
    ],
    [
      "expo-camera",
      { cameraPermission: "TAIL reads a friend's lobby code with the camera.", microphonePermission: false },
    ],
  ],
  extra: {
    contractId: env("TAIL_CONTRACT") ?? null,
    nearNetwork: env("NEAR_NETWORK") ?? "testnet",
  },
};

export default config;
