// Game and protocol constants. Mirrored byte for byte in crates/tail-protocol/src/constants.rs;
// the vectors test pins both. Change a value in both places in the same change.

/** Token lifetime: one epoch. */
export const EPOCH_MS = 15_000;
/** Phone report interval. */
export const BATCH_MS = 5_000;
/** Relay → referee call interval. S2 measured OutLayer p95 above 4 s, so ticks are 10 s. */
export const TICK_MS = 10_000;
/** Trailing window for the lock, in epochs (2 min). */
export const WINDOW_EPOCHS = 8;
/** Contact epochs inside the window needed to strike (about 60 s). */
export const LOCK_EPOCHS = 4;
/** Sightings weaker than this do not count. Calibrated in S1 / the field test. */
export const RSSI_MIN_DBM = -82;
/** Sightings of a token needed per epoch, per side. */
export const MIN_SAMPLES = 2;
/** Max distance between the two fixes, on top of both accuracies. */
export const GEO_SLACK_M = 40;
/** A fix with worse accuracy is ignored. */
export const MAX_ACC_M = 50;
/** Max age of a fix used for an epoch, measured from the epoch midpoint. */
export const FIX_WINDOW_MS = 10_000;
/** Faster than this for VEHICLE_HOLD_MS counts as a vehicle. */
export const MAX_SPEED_MPS = 7;
export const VEHICLE_HOLD_MS = 20_000;
/** A vehicle freezes the lock for this long. */
export const VEHICLE_FREEZE_MS = 120_000;
/** Implied speed between consecutive fixes above this rejects the batch. */
export const TELEPORT_MPS = 15;
/** A batch may be dated at most this far ahead of the referee clock; only batches this fresh refresh presence. */
export const CLOCK_SKEW_MS = 20_000;
/** No valid batch for this long: the hunter gets a coarse grid cell. */
export const DARK_LEAK_MS = 45_000;
/** Size of the leaked grid cell. */
export const LEAK_CELL_M = 100;
/** Cumulative dark time that forfeits the head to the hunter. */
export const DARK_FORFEIT_MS = 180_000;
export const HINT_COOLDOWN_MS = 30_000;
/** Radius for the NEAR hint. */
export const HINT_NEAR_M = 150;
/** Look-back for the TREND hint. */
export const HINT_TREND_MS = 60_000;
/** Merkle root anchored on NEAR this often. */
export const CHECKPOINT_MS = 60_000;
/** No verdict for this long: anyone may abort and refund. */
export const REFEREE_TIMEOUT_MS = 900_000;
/** Max length of a player's free-text question to the Handler. */
export const HINT_TEXT_MAX = 140;
/**
 * Most hints one match may charge. The contract keeps one record per hint until End replays them
 * and pays for that storage at creation, so the count needs a bound: 20 per player at 12 players.
 * The referee refuses the next one (RefuseCode.HintLimit).
 */
export const MAX_HINTS = 240;
/**
 * Plaintext size of every message the referee seals to a phone (SignedPlayerKeys, SignedHud,
 * SignedVoiceLine): u32le(len) ‖ borsh ‖ zeros, so the sealed size (32 + 1024 + 16 bytes) is the
 * same whatever the target's account id, the HUD's options or the Handler's words. The largest
 * HUD (two 64-byte account ids, every option set) is 401 bytes signed; keys are at most 230.
 */
export const PHONE_PAD = 1024;
/**
 * Most bytes of Handler text that fit PHONE_PAD: the rest of a SignedVoiceLine is 90 bytes (match
 * id 16, player 2, hint id 4, text length 4, signature 64), and the length prefix 4.
 */
export const VOICE_TEXT_MAX = PHONE_PAD - 4 - 90;

export const HintKind = { Near: 0, Bearing: 1, Trend: 2 } as const;
export type HintKind = (typeof HintKind)[keyof typeof HintKind];

/** Fix.flags bits (CLLocationSourceInformation). Any set bit makes the batch invalid. */
export const FixFlag = { SimulatedBySoftware: 1, ProducedByAccessory: 2 } as const;

/**
 * Why the referee refused a batch: LogEntry `Rejected.code` and `Hud.rejected.code`. Shared so
 * the phone can name the reason without knowing the referee's types.
 */
export const RejectCode = {
  UnknownPlayer: 1,
  WrongMatch: 2,
  PlayerOut: 3,
  /** `seq` is not the next one expected. */
  Seq: 4,
  /** `prev` is not the hash of the last accepted batch. */
  Prev: 5,
  /** The App Attest assertion did not verify. */
  Assertion: 6,
  ClockSkew: 7,
  /** A fix was simulated or came from an accessory. */
  FixFlags: 8,
  /** Fixes out of time order. */
  FixOrder: 9,
  Teleport: 10,
  /** `t_ms` went backwards against an earlier batch of the same player. */
  TimeOrder: 11,
  /** Dated before the evidence the referee still keeps, so nothing in it could count. */
  TooOld: 12,
} as const;

/**
 * Why the referee took no action on a valid batch's Strike or Hint: the `reason` of a tick's
 * `refused` list. The amounts some refusals carry (a lock count, a head) stay with the referee;
 * the player sees them in the signed HUD.
 */
export const RefuseCode = {
  PlayerOut: 1,
  TimeUp: 2,
  /** Only one player is left. */
  MatchOver: 3,
  /** Strike: the lock was not full. */
  Lock: 4,
  /** Strike: no contact with the target in the strike's epoch or the one before. */
  NoContact: 5,
  UnknownHint: 6,
  /** Hint: the question is over HINT_TEXT_MAX characters. */
  TextTooLong: 7,
  /** Hint: too soon after the last one. */
  Cooldown: 8,
  /** Hint: the asker's head cannot pay for it. */
  Funds: 9,
  /** Hint: no usable fix for the asker or the target. */
  NoFix: 10,
  /** Hint: the match already charged MAX_HINTS. */
  HintLimit: 11,
} as const;

/** Domain strings. Every hash or MAC input starts with one, so no two contexts collide. */
export const Domain = {
  tag: "tail/tag",
  beacon: "tail/beacon",
  tagMac: "tag",
  tokenMac: "tok",
  batch: "tail/batch",
  /** v2: the payload carries `prev`, the digest of the match's previous verdict. */
  verdict: "tail/verdict/v2",
  ring: "tail/ring",
  players: "tail/players",
  seal: "tail/seal/v1",
  enroll: "tail/enroll/v1",
  /** Signature digest of a Hud, and the seal context of a SignedHud. */
  hud: "tail/hud/v2",
  /** Signature digest of PlayerKeys, and the seal context of a SignedPlayerKeys. */
  keys: "tail/keys/v2",
  /** Signature digest of a VoiceLine, and the seal context of a SignedVoiceLine. */
  voice: "tail/voice/v1",
  /** HKDF info of K_log, the match's log-salt key. */
  log: "tail/log",
  /** HMAC prefix of a log entry's salt. */
  logSalt: "tail/log-salt",
  /** Seal context of a mesh-carried request (phone → relay). */
  carry: "tail/carry/v1",
  /** Signature digest of the relay's receipt for a carried envelope. */
  carryAck: "tail/carry-ack/v1",
  /** Re-enrolment of an account: the old NEAR key signs the new device's keys. */
  rebind: "tail/rebind/v1",
} as const;

/** The `context` (AAD) of every sealed message, by what it holds. */
export const SealContext = {
  batch: Domain.batch,
  hud: Domain.hud,
  keys: Domain.keys,
  voice: Domain.voice,
  carry: Domain.carry,
} as const;
