//! The match log as an RFC 6962 Merkle frontier. The referee never needs old leaves, only the
//! current root, so it keeps one hash per set bit of the log size (≤ 64 hashes) instead of the
//! whole log. The relay keeps the entries themselves for `declassify` and inclusion proofs.

use borsh::{BorshDeserialize, BorshSerialize};
use tail_protocol::digest::sha256;
use tail_protocol::{merkle, Hash, LogEntry};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Log {
    size: u64,
    /// Roots of the perfect subtrees that make up the log, oldest (largest) first.
    peaks: Vec<Hash>,
}

fn node(l: &Hash, r: &Hash) -> Hash {
    sha256(&[&[1u8], l, r])
}

impl Log {
    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn push(&mut self, entry: &LogEntry) {
        let mut h = merkle::leaf(entry);
        let mut s = self.size;
        // Each trailing 1 bit of the old size is a perfect subtree of the same height as the
        // one being carried, so they merge.
        while s & 1 == 1 {
            let left = self.peaks.pop().expect("one peak per set bit");
            h = node(&left, &h);
            s >>= 1;
        }
        self.peaks.push(h);
        self.size += 1;
    }

    /// RFC 6962 MTH of the whole log: the peaks folded from the smallest upward.
    pub fn root(&self) -> Hash {
        let mut it = self.peaks.iter().rev();
        let Some(last) = it.next() else {
            return sha256(&[]);
        };
        it.fold(*last, |acc, p| node(p, &acc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_frontier_root_equals_the_full_tree_root_at_every_size() {
        let mut log = Log::default();
        let mut leaves = Vec::new();
        assert_eq!(log.root(), merkle::root(&leaves));
        for i in 0..70u32 {
            let e = LogEntry::Contact { a: 0, b: 1, epoch: i };
            leaves.push(merkle::leaf(&e));
            log.push(&e);
            assert_eq!(log.root(), merkle::root(&leaves), "size {}", i + 1);
            assert_eq!(log.size(), u64::from(i) + 1);
        }
    }
}
