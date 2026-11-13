import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { type ComponentType, useEffect, useState } from "react";
import { Animated, Settings as Defaults, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Briefing } from "./screens/Briefing";
import { Create } from "./screens/Create";
import { Enrol } from "./screens/Enrol";
import { Home } from "./screens/Home";
import { Hunt } from "./screens/Hunt";
import { Lobby } from "./screens/Lobby";
import { Primer } from "./screens/Primer";
import { Profile } from "./screens/Profile";
import { Results } from "./screens/Results";
import { Scan } from "./screens/Scan";
import { Settings } from "./screens/Settings";
import { app, useApp } from "./state/app";
import { Mark } from "./ui/brand";
import { rise, useArrive, useReduceMotion } from "./ui/motion";
import { Ripple } from "./ui/scene";
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

/** Each screen arrives with a short fade and rise (state, not choreography); instant with
 * Reduce Motion. */
function Route() {
  const a = useApp();
  const reduceMotion = useReduceMotion();
  const key = a.showSettings ? "settings" : a.route;
  const t = useArrive(key, reduceMotion);
  return (
    <View style={styles.fill}>
      <Animated.View style={[styles.fill, rise(t, 10)]}>
        <Screen route={a.route} settings={a.showSettings} reduceMotion={reduceMotion} />
      </Animated.View>
    </View>
  );
}

function Screen({
  route,
  settings,
  reduceMotion,
}: {
  route: ReturnType<typeof useApp>["route"];
  settings: boolean;
  reduceMotion: boolean;
}) {
  if (settings) return <Settings />;
  switch (route) {
    case "loading":
      // The splash's mark at the splash's size (120 pt), so the hand-off does not jump; the
      // rings say the app is still opening your keys.
      return (
        <View style={[styles.fill, styles.loading]} accessible accessibilityLabel="Loading">
          <Ripple size={280} reduceMotion={reduceMotion}>
            <Mark size={120} />
          </Ripple>
        </View>
      );
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
    case "profile":
      return <Profile />;
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

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.paper },
  loading: { alignItems: "center", justifyContent: "center" },
});

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
