// The app's building blocks, all styled from theme.ts. Every control has an accessible name and
// a hit target of at least HIT points. A screen's tone (paper, ink, persimmon) flows down through
// context so text always picks the colour that passes contrast on it.

import type { IconName } from "@tail/brand";
import { createContext, type ReactNode, useContext } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./brand";
import { color, HIT, maxScale, radius, STRIKE_HEIGHT, space, text } from "./theme";

export type Tone = "paper" | "ink" | "persimmon";

const ToneContext = createContext<Tone>("paper");
export const useTone = () => useContext(ToneContext);

export function ToneProvider({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <ToneContext.Provider value={tone}>{children}</ToneContext.Provider>;
}

/** Text colour for a tone: ink on paper and persimmon (the Ink Rule), paper on ink. */
export const inkOn = (t: Tone) => (t === "ink" ? color.paper : color.ink);
export const muteOn = (t: Tone) => (t === "ink" ? color.sand : t === "persimmon" ? color.ink : color.mute);
export const toneBg: Record<Tone, string> = {
  paper: color.paper,
  ink: color.ink,
  persimmon: color.persimmon,
};

export function Screen({
  children,
  tone = "paper",
  scroll = true,
  footer,
}: {
  children: ReactNode;
  tone?: Tone;
  scroll?: boolean;
  /** Pinned below the content, above the home indicator (primary actions, thumb reach). */
  footer?: ReactNode;
}) {
  const inset = useSafeAreaInsets();
  return (
    <ToneContext.Provider value={tone}>
      <View style={[s.fill, { backgroundColor: toneBg[tone], paddingTop: inset.top }]}>
        {scroll ? (
          <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        ) : (
          <View style={[s.pad, s.fill]}>{children}</View>
        )}
        {footer ? (
          <View style={[s.footer, { paddingBottom: Math.max(inset.bottom, space.l) }]}>{footer}</View>
        ) : null}
      </View>
    </ToneContext.Provider>
  );
}

type TextProps = {
  children: ReactNode;
  style?: TextStyle;
  center?: boolean;
  muted?: boolean;
  lines?: number;
};

type Variant = keyof typeof VARIANTS;
const VARIANTS = {
  eyebrow: [text.eyebrow, maxScale.text],
  caption: [text.caption, maxScale.text],
  label: [text.label, maxScale.text],
  body: [text.body, maxScale.text],
  strong: [text.bodyStrong, maxScale.text],
  title: [text.title, maxScale.text],
  display: [text.display, maxScale.number],
  poster: [text.poster, maxScale.number],
  num: [text.number, maxScale.number],
  figure: [text.figure, maxScale.text],
} as const satisfies Record<string, readonly [TextStyle, number]>;
const HEADERS: readonly Variant[] = ["title", "display", "poster"];

function T({ v, children, style, center, muted, lines }: TextProps & { v: Variant }) {
  const tone = useTone();
  const [base, scale] = VARIANTS[v];
  return (
    <Text
      {...(HEADERS.includes(v) ? { accessibilityRole: "header" as const } : {})}
      maxFontSizeMultiplier={scale}
      numberOfLines={lines}
      style={[base, { color: muted ? muteOn(tone) : inkOn(tone) }, center && s.center, style]}
    >
      {children}
    </Text>
  );
}

export const Eyebrow = (p: TextProps) => <T v="eyebrow" {...p} />;
export const Caption = (p: TextProps) => <T v="caption" {...p} />;
export const Label = (p: TextProps) => <T v="label" {...p} />;
export const Body = (p: TextProps) => <T v="body" {...p} />;
export const Strong = (p: TextProps) => <T v="strong" {...p} />;
export const Title = (p: TextProps) => <T v="title" {...p} />;
export const Display = (p: TextProps) => <T v="display" {...p} />;
export const Poster = (p: TextProps) => <T v="poster" {...p} />;
export const Num = (p: TextProps) => <T v="num" {...p} />;
export const Figure = (p: TextProps) => <T v="figure" {...p} />;

export type ButtonKind = "primary" | "secondary" | "quiet" | "strike";

export function Button({
  title,
  onPress,
  kind = "primary",
  icon,
  busy,
  disabled,
  hint,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  /** A brand game icon, only for game concepts. */
  icon?: IconName | undefined;
  /** Shows a spinner and blocks presses; the title says what is happening. */
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  style?: ViewStyle;
}) {
  const tone = useTone();
  // Outside the game, the primary action is ink; persimmon is spent only on STRIKE.
  const bg =
    kind === "strike"
      ? tone === "persimmon"
        ? color.ink
        : color.persimmon
      : kind === "primary"
        ? tone === "ink"
          ? color.paper
          : color.ink
        : kind === "secondary"
          ? tone === "ink"
            ? color.mute
            : color.sand
          : "transparent";
  const fg =
    kind === "strike"
      ? tone === "persimmon"
        ? color.persimmon
        : color.ink
      : kind === "primary"
        ? tone === "ink"
          ? color.ink
          : color.paper
        : kind === "secondary" && tone === "ink"
          ? color.paper
          : inkOn(tone);
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={({ pressed }) => [
        s.button,
        kind === "strike" && s.strike,
        kind === "quiet" && s.quiet,
        { backgroundColor: bg },
        disabled && s.disabled,
        pressed && s.pressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : icon ? (
        <Icon name={icon} size={kind === "strike" ? 36 : 20} tint={fg} />
      ) : null}
      <Text
        maxFontSizeMultiplier={kind === "strike" ? maxScale.number : maxScale.text}
        style={[kind === "strike" ? s.strikeText : s.buttonText, { color: fg }]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...input
}: { label: string; error?: string | null | undefined } & TextInputProps) {
  const tone = useTone();
  return (
    <View style={s.field}>
      <Text maxFontSizeMultiplier={maxScale.text} style={[text.label, { color: inkOn(tone) }]}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={color.mute}
        maxFontSizeMultiplier={maxScale.text}
        style={[s.input, error ? s.inputError : null]}
        {...input}
      />
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          maxFontSizeMultiplier={maxScale.text}
          style={[text.caption, s.errorText]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={s.toggle}>
      <Label>{label}</Label>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ true: color.ink, false: color.line }}
        thumbColor={color.paper}
        ios_backgroundColor={color.line}
      />
    </View>
  );
}

/** A player as initials in a soft circle, Find My style. */
export function Avatar({ name, size = 40, mark }: { name: string; size?: number; mark?: boolean }) {
  const handle = name.split(".")[0] ?? name;
  const initials = handle
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[s.avatar, { width: size, height: size, borderRadius: size / 2 }, mark && s.avatarMark]}
    >
      <Text allowFontScaling={false} style={[text.label, { color: color.ink, fontSize: size * 0.38 }]}>
        {initials || "?"}
      </Text>
    </View>
  );
}

/** An inline notice: icon, one line, optional detail. Errors are sentences, never colour alone. */
export function Notice({
  icon,
  title,
  detail,
}: {
  icon?: IconName;
  title: string;
  detail?: string | null | undefined;
}) {
  const tone = useTone();
  return (
    <View
      style={s.notice}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
    >
      {icon ? <Icon name={icon} size={20} tint={inkOn(tone)} /> : null}
      <View style={s.fillRow}>
        <Strong>{title}</Strong>
        {detail ? <Caption muted>{detail}</Caption> : null}
      </View>
    </View>
  );
}

export function Row({
  children,
  gap = "s",
  style,
}: {
  children: ReactNode;
  gap?: keyof typeof space;
  style?: ViewStyle;
}) {
  return <View style={[s.row, { gap: space[gap] }, style]}>{children}</View>;
}

export function Gap({ size = "l" }: { size?: keyof typeof space }) {
  return <View style={{ height: space[size] }} />;
}

export function Rule() {
  return <View style={s.rule} />;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  fillRow: { flex: 1, gap: 2 },
  pad: { paddingHorizontal: space.xl, paddingTop: space.l, paddingBottom: space.xxl, gap: space.m },
  footer: { paddingHorizontal: space.xl, paddingTop: space.m, gap: space.s },
  center: { textAlign: "center" },
  button: {
    minHeight: 52,
    minWidth: HIT,
    paddingHorizontal: space.xl,
    borderRadius: radius.m,
    flexDirection: "row",
    gap: space.s,
    alignItems: "center",
    justifyContent: "center",
  },
  quiet: { minHeight: HIT, paddingHorizontal: space.m },
  strike: { minHeight: STRIKE_HEIGHT, borderRadius: radius.l, gap: space.m },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.985 }] },
  buttonText: { ...text.label, fontSize: 17 },
  strikeText: {
    fontFamily: text.hero.fontFamily,
    fontSize: 40,
    letterSpacing: 4,
    textTransform: "uppercase",
  },
  field: { gap: space.xs },
  input: {
    minHeight: 52,
    paddingHorizontal: space.l,
    borderRadius: radius.s,
    backgroundColor: color.sand,
    ...text.body,
    color: color.ink,
  },
  inputError: { borderWidth: 2, borderColor: color.ink },
  errorText: { color: color.ink },
  toggle: { minHeight: HIT, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  avatar: { backgroundColor: color.sand, alignItems: "center", justifyContent: "center" },
  avatarMark: { borderWidth: 2, borderColor: color.ink },
  notice: { flexDirection: "row", gap: space.m, alignItems: "flex-start", paddingVertical: space.s },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.line },
});
