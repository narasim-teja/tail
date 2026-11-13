// The haptic vocabulary (docs/briefs/mobile.md 7): the phone is in a pocket with the screen off,
// so touch carries the game. Four named patterns plus the Handler's arrival. Haptics stay on
// with Reduce Motion: they are not motion.
import * as Haptics from "expo-haptics";

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

export const haptic = {
  /** A choice changed (chips, steppers), or a player arrived in the lobby. */
  select(): void {
    void Haptics.selectionAsync();
  },
  /** A countdown's last seconds and the moment the target is revealed. */
  tick(): void {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  },
  /** One heat beat; heavier as heat rises. Cadence: ui/cadence.ts. */
  heatTick(heat: number): void {
    const style =
      heat >= 4
        ? Haptics.ImpactFeedbackStyle.Heavy
        : heat >= 3
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light;
    void Haptics.impactAsync(style);
  },
  /** Lock full: two heavy knocks, unmistakable in a pocket. */
  lockFull(): void {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    later(140, () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
  },
  /** Strike sent: one sharp rigid tap the moment the thumb lands. */
  strikeSent(): void {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
  },
  /** Tagged: the error buzz, then a heavy drop. */
  tagged(): void {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    later(260, () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
  },
  /** A Handler dispatch arrived: a light double click, like a radio key. */
  dispatch(): void {
    void Haptics.selectionAsync();
    later(90, () => void Haptics.selectionAsync());
  },
};
