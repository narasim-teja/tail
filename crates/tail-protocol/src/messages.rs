//! Wire messages. Field order is the borsh order and must match
//! `packages/protocol/src/messages.ts`. Enum variant order is the u8 tag: append, never reorder.

use borsh::{BorshDeserialize, BorshSerialize};

pub type MatchId = [u8; 16];
pub type CallId = [u8; 16];
pub type Token = [u8; 16];
pub type Hash = [u8; 32];
/// Last field of the log entries whose other fields are guessable (`Contact`, `HintReceipt`,
/// `Evidence`): `log_salt(K_log, leaf index)`. During play the relay holds every leaf hash, and
/// without the salt it could hash each of the few thousand possible `Contact { a, b, epoch }`
/// and read the whole contact graph off the leaves.
pub type Salt = [u8; 16];

// ── Phone → enclave ─────────────────────────────────────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Fix {
    pub t_ms: u64,
    pub lat_e7: i32,
    pub lon_e7: i32,
    pub acc_m: u16,
    pub speed_cmps: u16,
    /// `fix_flag` bits; any set bit makes the batch invalid.
    pub flags: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Sighting {
    pub epoch: u32,
    pub token: Token,
    pub rssi_max: i8,
    pub rssi_med: i8,
    pub n: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Hint {
        hint: u8,
        nonce: u32,
        text: Option<String>,
    },
    Strike {
        nonce: u32,
    },
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    pub match_id: MatchId,
    pub player: u16,
    pub seq: u32,
    /// `SHA256(borsh(previous batch))`, zeros for seq 0.
    pub prev: Hash,
    pub t_ms: u64,
    pub fixes: Vec<Fix>,
    pub sightings: Vec<Sighting>,
    pub actions: Vec<Action>,
}

/// What a phone seals to the referee: the batch plus its App Attest assertion.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct BatchEnvelope {
    pub batch: Batch,
    pub assertion: Vec<u8>,
}

// ── Enclave → contract ──────────────────────────────────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Start {
        players_hash: Hash,
        ring_commit: Hash,
        start_ms: u64,
        end_ms: u64,
    },
    Hint {
        from: u16,
        to: u16,
        amount: u128,
        hint_id: u32,
        /// `hint_kind`, so the contract can check `amount == hint_price(stake, hint)`.
        hint: u8,
    },
    Tag {
        hunter: u16,
        target: u16,
    },
    Forfeit {
        player: u16,
        to: u16,
    },
    Checkpoint {
        log_size: u64,
        root: Hash,
    },
    End {
        alpha: String,
        vrf_signature: [u8; 64],
        log_size: u64,
        root: Hash,
    },
}

/// The signed part of a verdict. `prev` is the `verdict_digest` of the match's previous verdict
/// (zeros for the first, seq 1), so two different verdicts for one seq cannot both extend the
/// chain the contract holds. `call_id` is the OutLayer call that produced it, so the replay can
/// fetch that call's attestation record and check the executed wasm hash.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct VerdictPayload {
    pub match_id: MatchId,
    pub seq: u32,
    pub prev: Hash,
    pub call_id: CallId,
    pub body: Verdict,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignedVerdict {
    pub match_id: MatchId,
    pub seq: u32,
    pub prev: Hash,
    pub call_id: CallId,
    pub body: Verdict,
    pub sig: [u8; 64],
}

impl SignedVerdict {
    pub fn payload(&self) -> VerdictPayload {
        VerdictPayload {
            match_id: self.match_id,
            seq: self.seq,
            prev: self.prev,
            call_id: self.call_id,
            body: self.body.clone(),
        }
    }
}

// ── Match log ───────────────────────────────────────────────────────────────────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum LogEntry {
    Batch {
        player: u16,
        seq: u32,
        hash: Hash,
    },
    Contact {
        a: u16,
        b: u16,
        epoch: u32,
        salt: Salt,
    },
    Verdict {
        seq: u32,
        digest: Hash,
    },
    HintReceipt {
        hint_id: u32,
        chat_id: String,
        text_hash: Hash,
        signature: Vec<u8>,
        signing_address: String,
        salt: Salt,
    },
    /// One referee tick: when it ran and which OutLayer call ran it.
    Tick {
        tick_no: u32,
        now_ms: u64,
        call_id: CallId,
    },
    /// A batch the referee refused; `hash` is `batch_hash`, `code` a `reject_code`.
    Rejected {
        player: u16,
        seq: u32,
        hash: Hash,
        code: u8,
    },
    /// Written just before a Tag's `Verdict` entry: the strike and the contact epochs that
    /// justified it.
    Evidence {
        hunter: u16,
        target: u16,
        strike_seq: u32,
        strike_epoch: u32,
        epochs: Vec<u32>,
        salt: Salt,
    },
    /// At start, one per player: who plays as index `player`, with which device key.
    Enrolled {
        player: u16,
        account: String,
        key_hash: Hash,
        attested: bool,
    },
}

impl LogEntry {
    /// The entry's salt, for the kinds that carry one.
    pub fn salt(&self) -> Option<&Salt> {
        match self {
            LogEntry::Contact { salt, .. }
            | LogEntry::HintReceipt { salt, .. }
            | LogEntry::Evidence { salt, .. } => Some(salt),
            _ => None,
        }
    }
}

/// "These two phones were near each other": a `LogEntry::Contact` with its audit path to a root
/// that the contract `contract` anchored for match `match_id`, plus the account ids it names.
/// Checked from chain data alone (`presence::verify_presence`); no new signature.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PresenceProof {
    pub match_id: MatchId,
    pub contract: String,
    pub entry: LogEntry,
    pub index: u64,
    pub size: u64,
    pub path: Vec<Hash>,
    /// Accounts of players `a` and `b` of the entry, in that order.
    pub accounts: [String; 2],
}

// ── Enclave → phone (signed by the referee, sealed to the player's box key) ──────

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PlayerKeys {
    pub match_id: MatchId,
    pub player: u16,
    pub start_ms: u64,
    pub end_ms: u64,
    pub k_tag: [u8; 32],
    pub k_player: [u8; 32],
    /// Account id of this player's target.
    pub target: String,
}

/// Anyone holding a player's box public key can seal to it, the relay included, so the
/// referee signs what it seals: `sig = ed25519(referee_sk, keys_sig_digest(keys))`.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignedPlayerKeys {
    pub keys: PlayerKeys,
    pub sig: [u8; 64],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GridCell {
    pub lat_e7: i32,
    pub lon_e7: i32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HintFact {
    pub hint_id: u32,
    pub hint: u8,
    /// NEAR: 0/1. BEARING: 0..7 (N, NE, E, …). TREND: 0 farther, 1 closer, 2 same.
    pub value: u8,
}

/// Per-tick heads-up display for one player: only their own data.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Hud {
    pub match_id: MatchId,
    pub player: u16,
    pub tick: u32,
    pub epoch: u32,
    pub lock: u8,
    pub heat: u8,
    pub head: u128,
    pub status: u8,
    pub target: String,
    pub leak: Option<GridCell>,
    pub hint_fact: Option<HintFact>,
    /// Once this player is out: the account that took their head (the hunter for a Tag, the
    /// receiver for a Forfeit). Lets the phone name who got them.
    pub tagged_by: Option<String>,
    /// The seq the referee expects next from this player, and the hash of their last accepted
    /// batch: a phone that lost its outbox rebuilds its chain from these two.
    pub next_seq: u32,
    pub chain_tip: Hash,
    /// Cumulative dark time so far.
    pub dark_ms: u32,
    /// Tags this player has made.
    pub tags: u8,
    /// The log at the end of this tick, so the phone can ask for an inclusion proof later.
    pub log_size: u64,
    pub root: Hash,
    /// This player's latest refused batch: `(seq, reject_code)`.
    pub rejected: Option<(u32, u8)>,
}

/// `sig = ed25519(referee_sk, hud_sig_digest(hud))`; see `SignedPlayerKeys` for why.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignedHud {
    pub hud: Hud,
    pub sig: [u8; 64],
}

/// The Handler's words for one hint, sealed to the asker so the relay can neither read nor
/// swap them.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct VoiceLine {
    pub match_id: MatchId,
    pub player: u16,
    pub hint_id: u32,
    pub text: String,
}

/// `sig = ed25519(referee_sk, voice_sig_digest(line))`: sealing alone would stop reading, not
/// swapping, since the relay can seal to the asker too.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignedVoiceLine {
    pub line: VoiceLine,
    pub sig: [u8; 64],
}
