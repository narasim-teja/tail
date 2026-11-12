import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

// TAIL buttons on dusk: quiet by default, solid only for the one action that matters on a
// surface. Hit targets stay at 44 px on touch even when the visible control is smaller.
const buttonVariants = cva(
  "relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold outline-none transition-[background-color,color,transform] duration-150 ease-out-quart focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']",
  {
    variants: {
      variant: {
        solid: "bg-text text-surface hover:bg-text-2",
        quiet: "bg-surface-2 text-text hover:bg-surface-3",
        ghost: "text-text-2 hover:bg-surface-2 hover:text-text",
        link: "rounded-sm px-0 text-text underline decoration-text-3 underline-offset-4 hover:decoration-text",
      },
      size: {
        md: "h-10 px-4 text-sm",
        sm: "h-8 px-3 text-[0.8125rem]",
        icon: "size-10",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "quiet", size: "md" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
