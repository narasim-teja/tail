//! RFC 6962 Merkle tree over the match log.

use crate::digest::sha256;
use crate::messages::{Hash, LogEntry};

pub fn leaf(entry: &LogEntry) -> Hash {
    sha256(&[
        &[0u8],
        &borsh::to_vec(entry).expect("borsh into a Vec cannot fail"),
    ])
}

fn node(l: &Hash, r: &Hash) -> Hash {
    sha256(&[&[1u8], l, r])
}

/// Largest power of two strictly below `n` (n ≥ 2).
fn split(n: usize) -> usize {
    let mut k = 1;
    while k << 1 < n {
        k <<= 1;
    }
    k
}

pub fn root(leaves: &[Hash]) -> Hash {
    match leaves.len() {
        0 => sha256(&[]),
        1 => leaves[0],
        n => {
            let k = split(n);
            node(&root(&leaves[..k]), &root(&leaves[k..]))
        }
    }
}

/// Audit path for leaf `index`, deepest sibling first.
pub fn proof(leaves: &[Hash], index: usize) -> Vec<Hash> {
    assert!(index < leaves.len(), "leaf index out of range");
    if leaves.len() == 1 {
        return Vec::new();
    }
    let k = split(leaves.len());
    let (mut path, sibling) = if index < k {
        (proof(&leaves[..k], index), root(&leaves[k..]))
    } else {
        (proof(&leaves[k..], index - k), root(&leaves[..k]))
    };
    path.push(sibling);
    path
}

pub fn verify(leaf: &Hash, index: usize, size: usize, proof: &[Hash], root: &Hash) -> bool {
    fn walk(leaf: &Hash, i: usize, n: usize, proof: &[Hash], depth: usize) -> Option<Hash> {
        if n == 1 {
            return (depth == proof.len()).then_some(*leaf);
        }
        let k = split(n);
        let sib = proof.get(proof.len().checked_sub(1 + depth)?)?;
        if i < k {
            walk(leaf, i, k, proof, depth + 1).map(|l| node(&l, sib))
        } else {
            walk(leaf, i - k, n - k, proof, depth + 1).map(|r| node(sib, &r))
        }
    }
    index < size && walk(leaf, index, size, proof, 0).is_some_and(|got| &got == root)
}
