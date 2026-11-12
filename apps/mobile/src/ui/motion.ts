// Reduce Motion: takeovers become instant colour changes, nothing pulses, haptics remain.
import { useEffect, useState } from "react";
import { AccessibilityInfo, Easing } from "react-native";
import { motion } from "./theme";

/** Exponential ease-out for entrances, ease-in for exits. No bounce anywhere. */
export const ease = { out: Easing.bezier(...motion.out), in: Easing.bezier(...motion.in) };

export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (live) setOn(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return on;
}
