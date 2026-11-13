//! The match log as an RFC 6962 Merkle frontier. The referee never needs old leaves: it keeps
//! the peaks of the log at the size the last Checkpoint anchored (one hash per set bit of that
//! size) and the leaf hashes appended since. That is enough for the current root and for the
//! consistency proof the next Checkpoint or End must carry (RFC 9162 §2.1.4), and it stays small
//! because every Checkpoint starts the list again. The relay keeps the entries themselves
//! (sealed) for `declassify` and the leaf hashes for inclusion proofs.

use borsh::{BorshDeserialize, BorshSerialize};
use tail_protocol::{merkle, Hash, LogEntry};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Log {
    /// Log size at the last anchor (0 before the first).
    anchored: u64,
    /// Peaks of the log at `anchored`, largest first.
    peaks: Vec<Hash>,
    /// Leaf hashes appended since `anchored`, in order.
    appended: Vec<Hash>,
}

/// Peaks of the log after appending `leaves` to a log of `size` leaves with `peaks`.
fn grow(mut peaks: Vec<Hash>, mut size: u64, leaves: &[Hash]) -> Vec<Hash> {
    for leaf in leaves {
        let mut h = *leaf;
        let mut s = size;
        // Each trailing 1 bit of the old size is a perfect subtree of the same height as the
        // one being carried, so they merge.
        while s & 1 == 1 {
            let left = peaks.pop().expect("one peak per set bit");
            h = merkle::node(&left, &h);
            s >>= 1;
        }
        peaks.push(h);
        size += 1;
    }
    peaks
}

impl Log {
    pub fn size(&self) -> u64 {
        self.anchored + self.appended.len() as u64
    }

    /// Appends one entry and returns its leaf hash.
    pub fn push(&mut self, entry: &LogEntry) -> Hash {
        let leaf = merkle::leaf(entry);
        self.appended.push(leaf);
        leaf
    }

    /// RFC 6962 MTH of the whole log.
    pub fn root(&self) -> Hash {
        merkle::root_from_frontier(self.anchored, &self.peaks, &self.appended)
            .expect("the peaks are those of the anchored size")
    }

    /// Anchors the log at its current size and returns `(from_size, path)`: the consistency
    /// proof from the previous anchor to now. Call it exactly when a Checkpoint or End takes
    /// `(size, root)`, so the next proof starts where the contract's last anchored root is.
    pub fn anchor(&mut self) -> (u64, Vec<Hash>) {
        let from = self.anchored;
        let path = merkle::consistency_proof_from_frontier(from, &self.peaks, &self.appended)
            .expect("the peaks are those of the anchored size");
        let appended = std::mem::take(&mut self.appended);
        self.peaks = grow(std::mem::take(&mut self.peaks), from, &appended);
        self.anchored = from + appended.len() as u64;
        (from, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(i: u32) -> LogEntry {
        LogEntry::Contact {
            a: 0,
            b: 1,
            epoch: i,
            salt: [0; 16],
        }
    }

    #[test]
    fn the_frontier_root_equals_the_full_tree_root_at_every_size() {
        let mut log = Log::default();
        let mut leaves = Vec::new();
        assert_eq!(log.root(), merkle::root(&leaves));
        for i in 0..70u32 {
            leaves.push(log.push(&entry(i)));
            assert_eq!(log.root(), merkle::root(&leaves), "size {}", i + 1);
            assert_eq!(log.size(), u64::from(i) + 1);
            // Anchor at irregular sizes so every split of peaks and appended leaves is covered.
            if i % 7 == 3 || i % 11 == 0 {
                log.anchor();
                assert_eq!(log.root(), merkle::root(&leaves), "after anchoring at {}", i + 1);
            }
        }
    }

    #[test]
    fn each_anchor_proves_consistency_with_the_one_before() {
        let mut log = Log::default();
        let mut leaves = Vec::new();
        let mut prev = (0u64, merkle::empty_root());
        for i in 0..70u32 {
            leaves.push(log.push(&entry(i)));
            if i % 5 != 2 {
                continue;
            }
            let root = log.root();
            let size = log.size();
            let (from, path) = log.anchor();
            assert_eq!(from, prev.0);
            assert!(merkle::verify_consistency(from, size, &prev.1, &root, &path));
            let m = usize::try_from(from).unwrap();
            assert_eq!(path, merkle::consistency_proof(&leaves, m), "{from} → {size}");
            prev = (size, root);
        }
    }
}
