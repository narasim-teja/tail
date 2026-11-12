// A QR code as one SVG path (ink modules on paper), from qrcode-generator. Pure, so it is tested.
import qrcode from "qrcode-generator";

export interface QrPath {
  /** Modules per side, without the quiet zone. */
  count: number;
  /** Path of every dark module in module units, offset by the 4-module quiet zone. */
  d: string;
}

export function qrPath(textValue: string): QrPath {
  const q = qrcode(0, "M");
  q.addData(textValue);
  q.make();
  const n = q.getModuleCount();
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  }
  return { count: n, d };
}
