// The brand's mark and icons (@tail/brand) as React Native views, plus the system's own icons.
// Game concepts (lock, heat, strike, the Handler…) use the brand's icons; everyday controls
// (settings, scan, share, back) use SF Symbols, so they read as iOS at a glance.

import { type IconName, iconSvg, markSvg } from "@tail/brand";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { markRotation } from "./mark";
import { color } from "./theme";

/** Your own map marker: the Trail mark, its trail pointing back along your heading. */
export function TrailMarker({ heading, size = 40 }: { heading: number | null; size?: number }) {
  return (
    <View style={{ transform: [{ rotate: `${markRotation(heading)}deg` }] }} accessibilityLabel="You">
      <SvgXml xml={markSvg({ size, color: color.persimmon })} width={size} height={size} />
    </View>
  );
}

/** A game icon, decorative: the control or label next to it carries the accessible name. */
export function Icon({
  name,
  size = 22,
  tint = color.ink,
}: {
  name: IconName;
  size?: number;
  tint?: string;
}) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SvgXml xml={iconSvg(name, { size, color: tint })} width={size} height={size} />
    </View>
  );
}

/** The Trail mark on its own, for the first screen. */
export function Mark({ size = 56 }: { size?: number }) {
  return <SvgXml xml={markSvg({ size, color: color.persimmon, label: "TAIL" })} width={size} height={size} />;
}

export type SystemSymbol = SFSymbol;

/** An SF Symbol, decorative: the control next to it carries the accessible name. */
export function SystemIcon({
  name,
  size = 20,
  tint = color.ink,
}: {
  name: SystemSymbol;
  size?: number;
  tint?: string;
}) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SymbolView name={name} size={size} tintColor={tint} weight="semibold" type="monochrome" />
    </View>
  );
}
