// The handful of building blocks every screen uses, all styled from theme.ts. Every control has
// an accessibility label and a hit target of at least HIT points.

import type { IconName } from "@tail/brand";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "./brand";
import { color, HIT, radius, STRIKE_HEIGHT, space, type } from "./theme";

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      {scroll ? (
        <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[s.pad, s.fill]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text style={s.title} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted,
  center,
}: {
  children: ReactNode;
  muted?: boolean;
  center?: boolean;
}) {
  return <Text style={[s.body, muted && s.muted, center && s.center]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

/** A number as a hero: tabular figures, large. */
export function Figure({ children, label, icon }: { children: ReactNode; label: string; icon?: IconName }) {
  return (
    <View accessible accessibilityLabel={`${label} ${String(children)}`}>
      <View style={s.labelRow}>
        {icon ? <Icon name={icon} size={16} tint={color.inkMuted} /> : null}
        <Text style={s.label}>{label}</Text>
      </View>
      <Text style={s.figure}>{children}</Text>
    </View>
  );
}

type ButtonKind = "primary" | "plain" | "strike";

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  hint,
  icon,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  icon?: IconName;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [s.button, s[kind], disabled && s.disabled, pressed && s.pressed]}
    >
      <View style={s.labelRow}>
        {icon ? <Icon name={icon} size={kind === "strike" ? 34 : 20} tint={color.onSignature} /> : null}
        <Text style={[s.buttonText, kind === "strike" && s.strikeText]}>{title}</Text>
      </View>
    </Pressable>
  );
}

export function Field({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={s.field}>
      <Label>{label}</Label>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={color.inkMuted}
        style={s.input}
        {...input}
      />
    </View>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={s.row}>{children}</View>;
}

export function Gap({ size = "l" }: { size?: keyof typeof space }) {
  return <View style={{ height: space[size] }} />;
}

/**
 * Lock or heat: segments plus the number, so the state never rests on colour alone
 * (DESIGN.md, the Never-Alone Rule).
 */
export function SegmentBar({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: "lock" | "heat";
}) {
  const fill = tone === "lock" ? color.signature : color.heat;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${label} ${value} of ${max}`}
      style={s.bar}
    >
      <View style={s.barHead}>
        <View style={s.labelRow}>
          <Icon name={tone} size={18} tint={color.inkMuted} />
          <Text style={s.label}>{label}</Text>
        </View>
        <Text style={s.barNumber}>
          {value}/{max}
        </Text>
      </View>
      <View style={s.segments}>
        {Array.from({ length: max }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
          <View key={i} style={[s.segment, { backgroundColor: i < value ? fill : color.surfaceSunk }]} />
        ))}
      </View>
    </View>
  );
}

export function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Text style={s.error} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

export const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.surface },
  pad: { padding: space.l, gap: space.m },
  fill: { flex: 1 },
  title: {
    fontFamily: type.family,
    fontSize: type.size.title,
    fontWeight: type.weight.bold,
    color: color.ink,
  },
  body: { fontFamily: type.family, fontSize: type.size.body, color: color.ink },
  muted: { color: color.inkMuted },
  center: { textAlign: "center" },
  label: {
    fontFamily: type.family,
    fontSize: type.size.label,
    fontWeight: type.weight.medium,
    color: color.inkMuted,
  },
  figure: { ...type.number, fontSize: type.size.display, color: color.ink },
  button: {
    minHeight: HIT,
    minWidth: HIT,
    paddingHorizontal: space.l,
    borderRadius: radius.m,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: color.signature },
  plain: { backgroundColor: color.surfaceSunk },
  strike: { backgroundColor: color.signature, minHeight: STRIKE_HEIGHT, borderRadius: radius.l },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  buttonText: {
    fontFamily: type.family,
    fontSize: type.size.body,
    fontWeight: type.weight.bold,
    color: color.onSignature,
  },
  strikeText: { fontSize: type.size.display, letterSpacing: 2 },
  field: { gap: space.xs },
  input: {
    minHeight: HIT,
    paddingHorizontal: space.m,
    borderRadius: radius.s,
    backgroundColor: color.surfaceSunk,
    fontFamily: type.family,
    fontSize: type.size.body,
    color: color.ink,
  },
  labelRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  row: { flexDirection: "row", gap: space.s, alignItems: "center", flexWrap: "wrap" },
  bar: { gap: space.xs },
  barHead: { flexDirection: "row", justifyContent: "space-between" },
  barNumber: { ...type.number, fontSize: type.size.title, color: color.ink },
  segments: { flexDirection: "row", gap: space.xs },
  segment: { flex: 1, height: 18, borderRadius: radius.s },
  error: {
    fontFamily: type.family,
    fontSize: type.size.label,
    fontWeight: type.weight.bold,
    color: color.danger,
  },
});
