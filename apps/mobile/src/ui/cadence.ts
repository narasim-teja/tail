import { LOCK_EPOCHS } from "@tail/protocol";

/**
 * How often the heat tick is felt, by heat level: faster as your hunter's lock on you grows, so
 * a pocketed phone tells you how close they are. Null at zero heat (silence).
 */
export function heatIntervalMs(heat: number): number | null {
  if (heat <= 0) return null;
  const steps = [4_000, 2_500, 1_500, 900];
  return steps[Math.min(heat, LOCK_EPOCHS) - 1] ?? 900;
}
