//! Presence proofs: "these two phones were near each other", checked from chain data alone.
//!
//! A `PresenceProof` is a `LogEntry::Contact` plus its audit path. It holds if the path leads to
//! a root the contract anchored for the match at that log size (a Checkpoint or End verdict),
//! and the accounts it names are the contract's players at the entry's indexes. The referee's
//! signature on that root is the only trust in it; the proof adds no signature of its own.
//! The caller fetches `roots` and `players` from `proof.contract` for `proof.match_id`.

use crate::merkle;
use crate::messages::{Hash, LogEntry, PresenceProof};

/// What a valid proof establishes: players `a` and `b` (accounts `accounts`) were in contact in
/// `epoch` of the match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Presence {
    pub a: u16,
    pub b: u16,
    pub epoch: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceError {
    /// The entry is not a `Contact`.
    NotContact,
    /// No anchored root has the proof's log size.
    NoRoot,
    /// The path does not lead from the entry to the anchored root.
    BadPath,
    /// An index in the entry is not a player of the match.
    UnknownPlayer,
    /// The accounts in the proof are not the players at the entry's indexes.
    WrongAccounts,
}

/// `roots` are the `(log_size, root)` pairs anchored on chain for the match; `players` the
/// match's account ids, index = player number.
pub fn verify_presence(
    proof: &PresenceProof,
    roots: &[(u64, Hash)],
    players: &[String],
) -> Result<Presence, PresenceError> {
    let LogEntry::Contact { a, b, epoch, .. } = proof.entry else {
        return Err(PresenceError::NotContact);
    };
    let root = roots
        .iter()
        .find(|(size, _)| *size == proof.size)
        .map(|(_, r)| r)
        .ok_or(PresenceError::NoRoot)?;
    if !merkle::verify(
        &merkle::leaf(&proof.entry),
        proof.index,
        proof.size,
        &proof.path,
        root,
    ) {
        return Err(PresenceError::BadPath);
    }
    let account = |i: u16| players.get(usize::from(i)).ok_or(PresenceError::UnknownPlayer);
    if *account(a)? != proof.accounts[0] || *account(b)? != proof.accounts[1] {
        return Err(PresenceError::WrongAccounts);
    }
    Ok(Presence { a, b, epoch })
}
