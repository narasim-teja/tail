// Player actions for the next batch (TECHNICAL.md 4.3, 4.7): Hint{kind, nonce, text?} and
// Strike{nonce}. The nonce lets the referee's "refused" answer name the action it refused.

import { type Action, HINT_TEXT_MAX, type HintKind } from "@tail/protocol";

const randomNonce = () => crypto.getRandomValues(new Uint32Array(1))[0] as number;

export class ActionQueue {
  private pending: Action[] = [];

  constructor(private readonly nonce: () => number = randomNonce) {}

  hint(kind: HintKind, question?: string): Action {
    const text = question?.trim().slice(0, HINT_TEXT_MAX);
    const a: Action = text
      ? { kind: "Hint", hint: kind, nonce: this.nonce(), text }
      : { kind: "Hint", hint: kind, nonce: this.nonce() };
    this.pending.push(a);
    return a;
  }

  strike(): Action {
    const a: Action = { kind: "Strike", nonce: this.nonce() };
    this.pending.push(a);
    return a;
  }

  get size(): number {
    return this.pending.length;
  }

  drain(): Action[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
