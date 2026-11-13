// The logos of what TAIL is built on, one ink colour each so they sit in a row with the brand's
// own icons. GitHub, NEAR and Apple are Simple Icons' paths (CC0); NEAR AI is NEAR's mark in the
// rounded square of its favicon; Offline Protocol is its favicon's pixel grid; OutLayer is its
// three chevrons and dot drawn flat. Each is decorative: the link beside it carries the name.

import { type ReactNode, useId } from "react";

export type LogoName = "github" | "near" | "nearai" | "outlayer" | "offline" | "apple";

const GITHUB =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";
const NEAR =
  "M21.443 0c-.89 0-1.714.46-2.18 1.218l-5.017 7.448a.533.533 0 0 0 .792.7l4.938-4.282a.2.2 0 0 1 .334.151v13.41a.2.2 0 0 1-.354.128L5.03.905A2.555 2.555 0 0 0 3.078 0h-.521A2.557 2.557 0 0 0 0 2.557v18.886a2.557 2.557 0 0 0 4.736 1.338l5.017-7.448a.533.533 0 0 0-.792-.7l-4.938 4.283a.2.2 0 0 1-.333-.152V5.352a.2.2 0 0 1 .354-.128l14.924 17.87c.486.574 1.2.905 1.952.906h.521A2.558 2.558 0 0 0 24 21.445V2.557A2.558 2.558 0 0 0 21.443 0Z";
const APPLE =
  "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";
/** Offline Protocol's favicon: filled cells of a 5 × 4 grid, as [column, row]. */
const OFFLINE_CELLS: [number, number][] = [
  [2, 0],
  [3, 0],
  [1, 1],
  [2, 1],
  [4, 1],
  [0, 2],
  [2, 2],
  [3, 2],
  [0, 3],
  [1, 3],
  [2, 3],
];

/** A chevron pointing right: arms from x0 at 12 ± h, tip at tx, t wide. */
const chevron = (x0: number, h: number, tx: number, t: number) =>
  `M${x0} ${12 - h}H${x0 + t}L${tx} 12L${x0 + t} ${12 + h}H${x0}L${tx - t} 12Z`;

export function Logo({ name, size = 20 }: { name: LogoName; size?: number }) {
  const id = useId();
  const { viewBox = "0 0 24 24", body } = art(name, id);
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      shapeRendering={name === "offline" ? "crispEdges" : undefined}
    >
      {body}
    </svg>
  );
}

function art(name: LogoName, id: string): { viewBox?: string; body: ReactNode } {
  switch (name) {
    case "github":
      return { body: <path d={GITHUB} /> };
    case "near":
      return { body: <path d={NEAR} /> };
    case "apple":
      return { body: <path d={APPLE} /> };
    case "nearai":
      return {
        body: (
          <>
            <mask id={id}>
              <rect width="24" height="24" fill="#fff" />
              <path d={NEAR} transform="translate(6.2 6.2) scale(.483)" fill="#000" />
            </mask>
            <rect width="24" height="24" rx="5" mask={`url(#${id})`} />
          </>
        ),
      };
    case "outlayer":
      return {
        body: (
          <>
            <mask id={id}>
              <rect width="24" height="24" fill="#fff" />
              <circle cx="19" cy="9.9" r="1.15" fill="#000" />
            </mask>
            <g mask={`url(#${id})`}>
              <path d={chevron(0.5, 4, 5.5, 2.6)} />
              <path d={chevron(5.5, 6.5, 12, 3.2)} />
              <path d={chevron(11.5, 9.5, 23.5, 4.2)} />
            </g>
          </>
        ),
      };
    case "offline":
      return {
        viewBox: "0 -0.5 5 5",
        body: OFFLINE_CELLS.map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="1" height="1" />),
      };
  }
}
