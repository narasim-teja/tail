// Money that counts to its new value in whole cents, so a change is seen as well as read: a head
// draining into the hunter's on a tag, the finale's standings. Lands on the exact amount; with
// reduced motion it is the exact amount from the start.

import { useEffect, useRef, useState } from "react";

const TWEEN_MS = 900;

/** `from` starts the count somewhere other than `value` (the finale counts up from the stake). */
export function useTween(value: bigint, reduced: boolean, decimals: number, from?: bigint): bigint {
  const [shown, setShown] = useState(reduced ? value : (from ?? value));
  const last = useRef(from ?? value);
  useEffect(() => {
    if (reduced) {
      last.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = last.current;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / TWEEN_MS);
      const e = 1 - (1 - k) ** 4;
      const cent = 10n ** BigInt(Math.max(0, decimals - 2));
      const v = ((a + ((value - a) * BigInt(Math.round(e * 1000))) / 1000n) / cent) * cent;
      setShown(k >= 1 ? value : v);
      last.current = k >= 1 ? value : v;
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, decimals]);
  return shown;
}
