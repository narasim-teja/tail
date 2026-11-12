// Scan to join: point the camera at a friend's lobby QR (tail://join/<match id>).
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../state/app";
import { Body, Button, Display, Screen, Strong, ToneProvider } from "../ui/kit";
import { color, radius, space } from "../ui/theme";

/** The match id in a scanned code, or null for anything that is not a TAIL lobby link. */
export function joinCode(data: string): string | null {
  return /^tail:\/\/join\/([0-9a-f]{32})$/.exec(data.trim())?.[1] ?? null;
}

export function ScanView({
  permission,
  onAllow,
  onScanned,
  onBack,
}: {
  permission: "granted" | "ask" | "denied";
  onAllow: () => void;
  onScanned: (matchId: string) => void;
  onBack: () => void;
}) {
  const inset = useSafeAreaInsets();
  const done = useRef(false);
  if (permission !== "granted") {
    return (
      <Screen
        scroll={false}
        footer={
          <>
            <Button
              title={permission === "denied" ? "Open Settings" : "Allow camera"}
              onPress={permission === "denied" ? () => void Linking.openSettings() : onAllow}
            />
            <Button kind="quiet" title="Back" onPress={onBack} />
          </>
        }
      >
        <View style={styles.center}>
          <Display>Scan to join</Display>
          <Body muted>
            {permission === "denied"
              ? "Camera access is off. Turn it on for TAIL in Settings, or enter the code on Home."
              : "TAIL uses the camera only to read a friend's lobby code."}
          </Body>
        </View>
      </Screen>
    );
  }
  return (
    <ToneProvider tone="ink">
      <View style={styles.fill}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(r) => {
            const id = joinCode(r.data);
            if (id && !done.current) {
              done.current = true;
              onScanned(id);
            }
          }}
          accessibilityLabel="Camera, looking for a lobby code"
        />
        <View
          style={[
            styles.overlay,
            { paddingTop: inset.top + space.l, paddingBottom: Math.max(inset.bottom, space.l) },
          ]}
        >
          <Strong style={styles.hint}>Point at the lobby code</Strong>
          <View style={styles.frame} />
          <Button title="Back" onPress={onBack} />
        </View>
      </View>
    </ToneProvider>
  );
}

export function Scan() {
  const app = useApp();
  const [perm, request] = useCameraPermissions();
  const permission = perm?.granted ? "granted" : perm && !perm.canAskAgain ? "denied" : "ask";
  return (
    <ScanView
      permission={permission}
      onAllow={() => void request()}
      onScanned={(id) => void app.openMatch(id)}
      onBack={() => app.openPage(null)}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.ink },
  center: { flex: 1, justifyContent: "center", gap: space.m },
  overlay: { flex: 1, justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.xl },
  hint: { textAlign: "center" },
  frame: { width: 248, height: 248, borderRadius: radius.l, borderWidth: 3, borderColor: color.paper },
});
