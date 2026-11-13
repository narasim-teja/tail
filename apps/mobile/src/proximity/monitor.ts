// The phone as a monitor of the referee's log, the way Certificate Transparency monitors watch a
// log (RFC 9162 8.3). Every signed HUD carries the log's size and root at the end of its tick.
// A referee (or anyone holding its key) could show this phone one history and anchor another on
// NEAR; only checking that the roots fit together catches it. So:
// - each time a signed HUD's log has grown, the phone asks the relay for a consistency proof from
//   the last root it verified and checks it against both signed roots
// - each root anchored on NEAR (read through the phone's own RPC) is checked the same way against
//   the newest verified HUD root, in whichever direction the sizes run
// - a later HUD with a smaller log, or a root of the same size that differs, needs no proof at all
//
// Fetches are rate-limited: one at a time, started by a HUD, an anchor read or a retry. HUDs that
// arrive meanwhile only move the target, so the phone catches up with one proof from the last
// verified root to the newest. The relay only supplies proofs: a fetch that fails, or an answer
// that is not a proof, is retried later and counts for nothing.
//
// A fork stops the monitor and is kept as evidence: the signed HUD bytes exactly as the referee
// signed them (both, or the HUD and the anchored root) and the proof that failed. Two signed roots
// that contradict by size alone convict the referee on their own. A proof that fails to verify
// could in principle be the relay lying, which `check` in forkJson says plainly.

import { type AnchoredRoot, equal, type Hud, toHex, verifyConsistency } from "@tail/protocol";
import { toB64 } from "../lib/b64";
import type { Timers } from "./epoch";

/** A log root the referee signed in a HUD. */
export interface SignedRoot {
  size: number;
  root: Uint8Array;
  /** The borsh SignedHud, exactly as the referee signed it: evidence anyone can check. */
  signed: Uint8Array;
}

/** A log root the contract anchored (a Checkpoint or End). */
export interface Anchor {
  size: number;
  root: Uint8Array;
}

/** Two roots the referee committed to that are not one growing log. */
export interface LogFork {
  atMs: number;
  /** The signed HUD root the phone had verified (or last took in). */
  hud: SignedRoot;
  /** What contradicts it: a later signed HUD, or a root anchored on NEAR. */
  other: { kind: "hud"; hud: SignedRoot } | { kind: "anchor"; anchor: Anchor };
  /** The relay's consistency proof between the two, which did not verify; empty when the sizes alone contradict. */
  proof: Uint8Array[];
}

/** What the monitor keeps in the match file. */
export interface MonitorRecord {
  /** The newest signed HUD root proven consistent with every one before it. */
  verified: SignedRoot | null;
  /** A newer signed root, not yet proven against `verified`. */
  pending: SignedRoot | null;
  /** The largest anchored log size checked against a HUD root. */
  anchored: number;
  /** Set once; the monitor stops there. */
  fork: LogFork | null;
}

export const freshMonitor = (): MonitorRecord => ({ verified: null, pending: null, anchored: 0, fork: null });

export interface MonitorDeps {
  /** The relay's consistency proof from size `from` to `to`, unverified. Throws when it can't be had. */
  consistency: (from: number, to: number) => Promise<Uint8Array[]>;
  /** The record changed outside `onHud` (a proof checked, an anchor checked, a fork): save it. */
  changed: () => void;
  onFork: (fork: LogFork) => void;
  now: () => number;
  timers: Timers;
}

/** How long after a failed fetch the monitor asks again, unless a HUD starts it sooner. */
export const MONITOR_RETRY_MS = 15_000;

/** One check: is the log of `from` with `oldRoot` a prefix of the log of `to` with `newRoot`? */
interface Job {
  from: number;
  to: number;
  oldRoot: Uint8Array;
  newRoot: Uint8Array;
  base: SignedRoot;
  other: LogFork["other"];
}

export class LogMonitor {
  private s: MonitorRecord;
  /** Anchored roots read but not yet checked, smallest first. */
  private anchors: Anchor[] = [];
  private busy: Promise<void> | null = null;
  private retry: unknown = null;
  private stopped = false;

  constructor(
    private readonly d: MonitorDeps,
    record: MonitorRecord,
  ) {
    this.s = { ...record };
  }

  get fork(): LogFork | null {
    return this.s.fork;
  }

  record(): MonitorRecord {
    return { ...this.s };
  }

  /**
   * A verified HUD newer than any before, with its signed bytes. Checks what needs no proof at
   * once and queues the rest; the caller saves the record afterwards.
   */
  onHud(hud: Hud, signed: Uint8Array): void {
    if (this.s.fork) return;
    const seen: SignedRoot = { size: Number(hud.logSize), root: hud.root, signed };
    const last = this.s.pending ?? this.s.verified;
    if (!last) {
      // Every log extends the empty one: a size-0 root is nothing to build on.
      if (seen.size > 0) this.s.verified = seen;
      return;
    }
    if (seen.size < last.size || (seen.size === last.size && !equal(seen.root, last.root))) {
      this.forked(last, { kind: "hud", hud: seen }, []);
      return;
    }
    if (seen.size === last.size) return;
    this.s.pending = seen;
    void this.kick();
  }

  /** Roots read from NEAR; each one not checked yet is checked against the newest verified HUD root. */
  checkAnchors(roots: readonly AnchoredRoot[]): Promise<void> {
    for (const r of roots) {
      const size = Number(r.logSize);
      if (size <= this.s.anchored || this.anchors.some((a) => a.size === size)) continue;
      this.anchors.push({ size, root: r.root });
    }
    this.anchors.sort((a, b) => a.size - b.size);
    return this.kick();
  }

  /** Picks up where the saved record left off (a pending root after a relaunch). */
  resume(): void {
    this.stopped = false;
    void this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) this.d.timers.clearTimeout(this.retry);
    this.retry = null;
  }

  /**
   * Starts the one fetch loop, or lets the running one pick up the new work. `busy` is cleared in
   * a `then`, which always runs after it is set; work that came in after the loop's last look is
   * picked up there.
   */
  private kick(): Promise<void> {
    if (this.busy) return this.busy;
    if (this.retry !== null) this.d.timers.clearTimeout(this.retry);
    this.retry = null;
    const p = this.loop()
      .catch(() => "failed" as const)
      .then((end) => {
        this.busy = null;
        if (end === "failed") this.scheduleRetry();
        else if (this.next()) return this.kick();
      });
    this.busy = p;
    return p;
  }

  /** Works through every job; "failed" when a proof could not be had. */
  private async loop(): Promise<"done" | "failed"> {
    // `next` is read again after each proof, so HUDs that came in during a fetch are caught up
    // with one proof from the root just verified.
    for (let job = this.next(); job; job = this.next()) {
      let proof: Uint8Array[] = [];
      if (job.from !== job.to) {
        try {
          proof = await this.d.consistency(job.from, job.to);
        } catch {
          // Unreachable relay, or an answer that is not a proof: try again later.
          return "failed";
        }
      }
      this.settle(job, proof);
    }
    return "done";
  }

  private next(): Job | null {
    const base = this.s.verified;
    if (this.stopped || this.s.fork || !base) return null;
    const p = this.s.pending;
    if (p)
      return {
        from: base.size,
        to: p.size,
        oldRoot: base.root,
        newRoot: p.root,
        base,
        other: { kind: "hud", hud: p },
      };
    const a = this.anchors[0];
    if (!a) return null;
    const other = { kind: "anchor", anchor: a } as const;
    return a.size >= base.size
      ? { from: base.size, to: a.size, oldRoot: base.root, newRoot: a.root, base, other }
      : { from: a.size, to: base.size, oldRoot: a.root, newRoot: base.root, base, other };
  }

  private settle(job: Job, proof: Uint8Array[]): void {
    if (!verifyConsistency(job.from, job.to, job.oldRoot, job.newRoot, proof)) {
      this.forked(job.base, job.other, proof);
      return;
    }
    if (job.other.kind === "hud") {
      this.s.verified = job.other.hud;
      if (this.s.pending === job.other.hud) this.s.pending = null;
    } else {
      const done = job.other.anchor;
      this.s.anchored = Math.max(this.s.anchored, done.size);
      this.anchors = this.anchors.filter((a) => a !== done);
    }
    this.d.changed();
  }

  private forked(hud: SignedRoot, other: LogFork["other"], proof: Uint8Array[]): void {
    const fork: LogFork = { atMs: this.d.now(), hud, other, proof };
    this.s.fork = fork;
    this.anchors = [];
    this.stop();
    this.d.changed();
    this.d.onFork(fork);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry !== null) return;
    this.retry = this.d.timers.setTimeout(() => {
      this.retry = null;
      void this.kick();
    }, MONITOR_RETRY_MS);
  }
}

const rootJson = (r: SignedRoot) => ({ log_size: r.size, root: toHex(r.root), signed_hud: toB64(r.signed) });

/** The fork as a JSON document to share: everything a third party needs to check it. */
export function forkJson(f: LogFork, matchId: string): string {
  const o = f.other;
  return JSON.stringify(
    {
      kind: "tail/log-fork/v1",
      match_id: matchId,
      found_at_ms: f.atMs,
      hud: rootJson(f.hud),
      other:
        o.kind === "hud"
          ? { kind: "hud", ...rootJson(o.hud) }
          : { kind: "anchor", log_size: o.anchor.size, root: toHex(o.anchor.root) },
      proof: f.proof.map(toHex),
      check:
        "decodeSignedHud(signed_hud) and verifySignedHud with referee_pk from get_match on the contract, for match_id; an anchor's root is in get_roots. A later HUD (higher tick) with a smaller log_size, or two roots of one log_size that differ, contradict on their own. Otherwise verifyConsistency(smaller size, larger size, its root, the other root, proof) from @tail/protocol fails; proof came from the relay, and anyone holding the log can try to build one that passes.",
    },
    null,
    2,
  );
}
