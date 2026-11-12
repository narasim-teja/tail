import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { type ComponentType, useEffect, useState } from "react";
import { Settings as Defaults, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Briefing } from "./screens/Briefing";
import { Create } from "./screens/Create";
import { Enrol } from "./screens/Enrol";
import { Home } from "./screens/Home";
import { Hunt } from "./screens/Hunt";
import { Lobby } from "./screens/Lobby";
import { Primer } from "./screens/Primer";
import { Results } from "./screens/Results";
import { Scan } from "./screens/Scan";
import { Settings } from "./screens/Settings";
import { app, useApp } from "./state/app";
import { color } from "./ui/theme";

// The splash (the Trail mark on paper) stays up until the app knows which screen to show.
void SplashScreen.preventAutoHideAsync();

type Frame = "pro" | "small";
type PreviewProps = { name: string | null; frame: Frame | null; onPick: (n: string) => void };
// Development builds, or a screenshot build made with EXPO_PUBLIC_DESIGN_PREVIEW=1. Both are
// constants at bundle time, so a normal Release bundle drops this branch and ships no fixtures.
const PREVIEW_BUILD = __DEV__ || process.env["EXPO_PUBLIC_DESIGN_PREVIEW"] === "1";
const DesignPreview: ComponentType<PreviewProps> | null = PREVIEW_BUILD
  ? require("./preview/Preview").Preview
  : null;

function Route() {
  const a = useApp();
  if (a.showSettings) return <Settings />;
  switch (a.route) {
    case "loading":
      return <View style={{ flex: 1, backgroundColor: color.paper }} />;
    case "enrol":
      return <Enrol />;
    case "primer":
      return <Primer />;
    case "home":
      return <Home />;
    case "create":
      return <Create />;
    case "scan":
      return <Scan />;
    case "lobby":
      return <Lobby />;
    case "briefing":
      return <Briefing />;
    case "hunt":
      return <Hunt />;
    case "results":
      return <Results />;
  }
}

/**
 * Which preview to show: a tail://preview/<state>?frame=… link, or the launch arguments
 * `-tailPreview <state> -tailFrame pro|small` (NSUserDefaults), which need no tap to open.
 */
function previewFrom(url: string | null): { name: string | null; frame: Frame | null } | null {
  const frameOf = (f: unknown): Frame | null => (f === "pro" || f === "small" ? f : null);
  const arg = Defaults.get("tailPreview") as unknown;
  if (typeof arg === "string") return { name: arg || null, frame: frameOf(Defaults.get("tailFrame")) };
  const m = url ? /^tail:\/\/preview\/?([a-z0-9-]*)(?:\?frame=(pro|small))?/.exec(url) : null;
  return m ? { name: m[1] || null, frame: frameOf(m[2]) } : null;
}

export default function App() {
  const url = Linking.useLinkingURL();
  const [pick, setPick] = useState<string | null>(null);
  const preview = DesignPreview ? previewFrom(url) : null;
  useEffect(() => {
    void app.init().finally(() => void SplashScreen.hideAsync());
  }, []);
  // tail://join/<match id> (the lobby QR) or tail://join/<lobby code> (a shared link) opens
  // that lobby.
  useEffect(() => {
    if (url?.startsWith("tail://join/") && app.ready) void app.openMatch(url);
  }, [url]);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {DesignPreview && preview ? (
        <DesignPreview name={pick ?? preview.name} frame={preview.frame} onPick={setPick} />
      ) : (
        <Route />
      )}
    </SafeAreaProvider>
  );
}
