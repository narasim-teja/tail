// The app's building blocks, all styled from theme.ts. Every control has an accessible name and
// a hit target of at least HIT points. A screen's tone (paper, ink, persimmon) flows down through
// context so text always picks the colour that passes contrast on it.

import type { IconName } from "@tail/brand";
import { createContext, type ReactNode, useContext, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
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
import { Icon, SystemIcon, type SystemSymbol } from "./brand";
import { haptic } from "./haptics";
import { ease } from "./motion";
import { color, HIT, maxScale, motion, radius, STRIKE_HEIGHT, space, text } from "./theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * A press that gives under the thumb: scale down fast on touch, settle back on release. Scale
 * is a transform on the native driver, so it is not layout motion and stays with Reduce Motion
 * (it is feedback, not movement across the screen).
 */
export function usePress(depth = 0.965) {
  const v = useRef(new Animated.Value(0)).current;
  const to = (x: number, ms: number) =>
    Animated.timing(v, { toValue: x, duration: ms, easing: ease.out, useNativeDriver: true }).start();
  return {
    scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, depth] }),
    onPressIn: () => to(1, 90),
    onPressOut: () => to(0, motion.base),
  };
}

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
  symbol,
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
  /** An SF Symbol, for everyday controls (share, scan, back). */
  symbol?: SystemSymbol | undefined;
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
  const press = usePress(kind === "strike" ? 0.94 : 0.965);
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={[
        s.button,
        kind === "strike" && s.strike,
        kind === "quiet" && s.quiet,
        { backgroundColor: bg, transform: [{ scale: press.scale }] },
        disabled && s.disabled,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : icon ? (
        <Icon name={icon} size={kind === "strike" ? 36 : 20} tint={fg} />
      ) : symbol ? (
        <SystemIcon name={symbol} size={17} tint={fg} />
      ) : null}
      <Text
        maxFontSizeMultiplier={kind === "strike" ? maxScale.number : maxScale.text}
        style={[kind === "strike" ? s.strikeText : s.buttonText, { color: fg }]}
      >
        {title}
      </Text>
    </AnimatedPressable>
  );
}

/**
 * One choice from a few: pills in a row, the chosen one in ink. Used where typing a number
 * would be a chore (stake, length, zone). A selection tick on change, like an iOS picker.
 */
export function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const tone = useTone();
  return (
    <View style={s.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text maxFontSizeMultiplier={maxScale.text} style={[text.label, { color: inkOn(tone) }]}>
        {label}
      </Text>
      <View style={s.chips}>
        {options.map((o) => (
          <Chip
            key={String(o.value)}
            label={o.label}
            on={o.value === value}
            onPress={() => {
              if (o.value !== value) haptic.select();
              onChange(o.value);
            }}
          />
        ))}
      </View>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const press = usePress(0.94);
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={[s.chip, on ? s.chipOn : null, { transform: [{ scale: press.scale }] }]}
    >
      <Text
        maxFontSizeMultiplier={maxScale.text}
        style={[text.figure, { fontSize: 17, color: on ? color.paper : color.ink }]}
      >
        {label}
      </Text>
    </AnimatedPressable>
  );
}

/** A count with − and + either side (players to start). */
export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  unit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  unit?: (n: number) => string;
}) {
  const tone = useTone();
  const step = (d: number) => {
    const n = Math.min(max, Math.max(min, value + d));
    if (n !== value) {
      haptic.select();
      onChange(n);
    }
  };
  return (
    <View
      style={s.stepper}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: unit ? unit(value) : String(value) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === "increment" ? 1 : -1)}
    >
      <View style={s.fillRow}>
        <Text maxFontSizeMultiplier={maxScale.text} style={[text.label, { color: inkOn(tone) }]}>
          {label}
        </Text>
        <Text maxFontSizeMultiplier={maxScale.number} style={[text.number, { color: inkOn(tone) }]}>
          {unit ? unit(value) : value}
        </Text>
      </View>
      <StepButton sign="-" off={value <= min} onPress={() => step(-1)} />
      <StepButton sign="+" off={value >= max} onPress={() => step(1)} />
    </View>
  );
}

function StepButton({ sign, off, onPress }: { sign: "-" | "+"; off: boolean; onPress: () => void }) {
  const press = usePress(0.9);
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      disabled={off}
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={[s.stepButton, off && s.disabled, { transform: [{ scale: press.scale }] }]}
    >
      <Text allowFontScaling={false} style={s.stepSign}>
        {sign === "-" ? "\u2212" : "+"}
      </Text>
    </AnimatedPressable>
  );
}

/** A control that is only an icon (settings in a header). The label is what VoiceOver says. */
export function IconButton({
  symbol,
  label,
  onPress,
}: {
  symbol: SystemSymbol;
  label: string;
  onPress: () => void;
}) {
  const tone = useTone();
  const press = usePress(0.9);
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[s.iconButton, { transform: [{ scale: press.scale }] }]}
    >
      <SystemIcon name={symbol} size={22} tint={inkOn(tone)} />
    </AnimatedPressable>
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
  // A few options share the row equally, so a fourth never wraps alone onto a second line.
  chips: { flexDirection: "row", gap: space.s },
  chip: {
    flex: 1,
    minHeight: HIT,
    paddingHorizontal: space.s,
    borderRadius: radius.pill,
    backgroundColor: color.sand,
    alignItems: "center",
    justifyContent: "center",
  },
  chipOn: { backgroundColor: color.ink },
  iconButton: { width: HIT, height: HIT, alignItems: "center", justifyContent: "center" },
  stepper: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: HIT },
  stepButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.sand,
    alignItems: "center",
    justifyContent: "center",
  },
  stepSign: { fontFamily: text.title.fontFamily, fontSize: 26, lineHeight: 30, color: color.ink },
});
