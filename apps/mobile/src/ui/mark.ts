/**
 * The Trail mark (@tail/brand) is drawn moving north-east, its trail running back to the lower
 * left, so it turns by heading − 45° to point the way you are going. Without a heading it stays
 * as drawn.
 */
export const markRotation = (heading: number | null) =>
  heading === null ? 0 : (((heading - 45) % 360) + 360) % 360;
