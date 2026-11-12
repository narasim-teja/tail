import { Slider as SliderPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

// The scrubber's rail and thumb. Radix gives it keyboard steps and aria-valuetext; the track is
// thin to look at and tall to grab.
function Slider({
  className,
  label,
  valueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & { label: string; valueText: string }) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("group relative flex h-8 w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-[3px] grow rounded-full bg-rail transition-[height] duration-200 ease-out-quart group-hover:h-[5px]"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full rounded-full bg-text-2" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={label}
        aria-valuetext={valueText}
        className="block size-3.5 rounded-full bg-text shadow-[0_0_0_4px_var(--color-scrim)] outline-none transition-transform duration-150 ease-out-quart hover:scale-115 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-text"
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
