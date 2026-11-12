// Whole-page states before there is a match to play: loading, private, not finished, missing,
// broken. Calm, short, and each says what to do next.

import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { TrailMark } from "./icons.tsx";

export function ProgressLine({ value }: { value: number }) {
  const done = value >= 1;
  return (
    <div
      role="progressbar"
      aria-label="Loading and checking the match"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="pointer-events-none fixed inset-x-0 top-0 z-tooltip h-[2px] transition-opacity delay-500 duration-700"
      style={{ opacity: done ? 0 : 1 }}
    >
      <div
        className="h-full origin-left bg-text-2 transition-transform duration-500 ease-out-quart"
        style={{ transform: `scaleX(${Math.max(0.04, value)})` }}
      />
    </div>
  );
}

export function PageState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-dusk px-6">
      <div className="max-w-[26rem]">
        <TrailMark className="size-10" />
        <h1 className="mt-6 text-[1.75rem] font-bold leading-tight tracking-[-0.01em] text-balance [font-stretch:104%]">
          {title}
        </h1>
        {children && (
          <div className="mt-3 text-[1rem] leading-relaxed text-text-2 text-pretty">{children}</div>
        )}
        {action && <div className="mt-7">{action}</div>}
      </div>
    </main>
  );
}

export function Retry({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="solid" onClick={onClick}>
      <RotateCw />
      Try again
    </Button>
  );
}
