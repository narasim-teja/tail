import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Briefing } from "./screens/Briefing";
import { Enrol } from "./screens/Enrol";
import { Home } from "./screens/Home";
import { Hunt } from "./screens/Hunt";
import { Lobby } from "./screens/Lobby";
import { Results } from "./screens/Results";
import { Settings } from "./screens/Settings";
import { app, useApp } from "./state/app";
import { color } from "./ui/theme";

function Route() {
  const a = useApp();
  if (a.showSettings) return <Settings />;
  switch (a.route) {
    case "loading":
      return (
        <View style={{ flex: 1, justifyContent: "center", backgroundColor: color.surface }}>
          <ActivityIndicator color={color.ink} accessibilityLabel="Loading" />
        </View>
      );
    case "enrol":
      return <Enrol />;
    case "home":
      return <Home />;
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

export default function App() {
  useEffect(() => {
    void app.init();
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Route />
    </SafeAreaProvider>
  );
}
