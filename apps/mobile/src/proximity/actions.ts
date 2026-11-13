// Game actions waiting for the next batch (TECHNICAL.md 4.3). The proximity layer does not read
// them: it carries whatever wire `Action` the game built (TAIL: tail/actions.ts) inside the next
// signed, sealed batch, in the order they were queued.

import type { Action } from "@tail/protocol";

export class ActionQueue {
  private pending: Action[];

  /** `saved`: actions a relaunch found unsent in the match file. */
  constructor(saved: readonly Action[] = []) {
    this.pending = [...saved];
  }

  push(a: Action): void {
    this.pending.push(a);
  }

  get size(): number {
    return this.pending.length;
  }

  /** The queued actions, oldest first, without taking them. */
  peek(): readonly Action[] {
    return this.pending;
  }

  drain(): Action[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
