//! RFC 6962 Merkle tree over the match log, with the inclusion (RFC 9162 §2.1.3) and
//! consistency (§2.1.4) proofs.
//!
//! The verifiers have `_with` forms that take the hash function, so the NEAR contract can run
//! them on its SHA-256 host function (`env::sha256_array`), which costs far less gas than SHA-256
//! compiled into the wasm. Everything else uses `sha2`.

use crate::digest::sha256;
use crate::messages::{Hash, LogEntry};

/// SHA-256 of one byte string: the hash the plain (non-`_with`) functions use.
pub fn sha256_one(data: &[u8]) -> Hash {
    sha256(&[data])
}

pub fn leaf(entry: &LogEntry) -> Hash {
    sha256(&[
        &[0u8],
        &borsh::to_vec(entry).expect("borsh into a Vec cannot fail"),
    ])
}

fn node_with<H: Fn(&[u8]) -> Hash>(hash: &H, l: &Hash, r: &Hash) -> Hash {
    let mut buf = [0u8; 65];
    buf[0] = 1;
    buf[1..33].copy_from_slice(l);
    buf[33..].copy_from_slice(r);
    hash(&buf)
}

/// `SHA256(0x01 ‖ l ‖ r)`.
pub fn node(l: &Hash, r: &Hash) -> Hash {
    node_with(&sha256_one, l, r)
}

/// Root of the empty log, `SHA256("")`.
pub fn empty_root() -> Hash {
    sha256(&[])
}

/// Largest power of two strictly below `n` (n ≥ 2).
fn split(n: u64) -> u64 {
    1 << (n - 1).ilog2()
}

pub fn root(leaves: &[Hash]) -> Hash {
    match leaves.len() {
        0 => empty_root(),
        1 => leaves[0],
        n => {
            let k = split(n as u64) as usize;
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
    let k = split(leaves.len() as u64) as usize;
    let (mut path, sibling) = if index < k {
        (proof(&leaves[..k], index), root(&leaves[k..]))
    } else {
        (proof(&leaves[k..], index - k), root(&leaves[..k]))
    };
    path.push(sibling);
    path
}

pub fn verify(leaf: &Hash, index: u64, size: u64, proof: &[Hash], root: &Hash) -> bool {
    verify_with(sha256_one, leaf, index, size, proof, root)
}

/// RFC 9162 §2.1.3.2: does `proof` place `leaf` at `index` in the tree of `size` with `root`?
pub fn verify_with<H: Fn(&[u8]) -> Hash>(
    hash: H,
    leaf: &Hash,
    index: u64,
    size: u64,
    proof: &[Hash],
    root: &Hash,
) -> bool {
    if index >= size {
        return false;
    }
    let (mut f, mut s) = (index, size - 1);
    let mut r = *leaf;
    for p in proof {
        if s == 0 {
            return false;
        }
        if f & 1 == 1 || f == s {
            r = node_with(&hash, p, &r);
            while f & 1 == 0 && f != 0 {
                f >>= 1;
                s >>= 1;
            }
        } else {
            r = node_with(&hash, &r, p);
        }
        f >>= 1;
        s >>= 1;
    }
    s == 0 && &r == root
}

/// The perfect subtrees a log of `size` leaves is made of, as leaf ranges, largest first.
fn peak_ranges(size: u64) -> Vec<(u64, u64)> {
    let mut lo = 0;
    let mut out = Vec::new();
    for bit in (0..64).rev() {
        let s = 1u64 << bit;
        if size & s != 0 {
            out.push((lo, lo + s));
            lo += s;
        }
    }
    out
}

/// Roots of the perfect subtrees that make up the log (one per set bit of its size), largest
/// first: all a writer needs to keep to append and to prove consistency later.
pub fn peaks(leaves: &[Hash]) -> Vec<Hash> {
    peak_ranges(leaves.len() as u64)
        .into_iter()
        .map(|(lo, hi)| root(&leaves[lo as usize..hi as usize]))
        .collect()
}

/// SUBPROOF(m, D[lo:hi], complete) of RFC 9162 §2.1.4.1 (m counted from `lo`), over an oracle for
/// MTH(D[a:b]). `None` when the oracle cannot produce a subtree.
fn subproof<F: Fn(u64, u64) -> Option<Hash>>(
    m: u64,
    lo: u64,
    hi: u64,
    complete: bool,
    mth: &F,
    out: &mut Vec<Hash>,
) -> Option<()> {
    if m == hi - lo {
        if !complete {
            out.push(mth(lo, hi)?);
        }
        return Some(());
    }
    let k = split(hi - lo);
    if m <= k {
        subproof(m, lo, lo + k, complete, mth, out)?;
        out.push(mth(lo + k, hi)?);
    } else {
        subproof(m - k, lo + k, hi, false, mth, out)?;
        out.push(mth(lo, lo + k)?);
    }
    Some(())
}

/// Consistency proof from the tree of the first `m` leaves to the tree of all of them.
pub fn consistency_proof(leaves: &[Hash], m: usize) -> Vec<Hash> {
    assert!(m <= leaves.len(), "old size beyond the log");
    let mut out = Vec::new();
    if m > 0 {
        let mth = |a: u64, b: u64| Some(root(&leaves[a as usize..b as usize]));
        subproof(m as u64, 0, leaves.len() as u64, true, &mth, &mut out).expect("full leaves");
    }
    out
}

/// What a writer that never keeps old leaves holds: the peaks of the log at size `m` and the
/// leaf hashes appended since.
struct Frontier<'a> {
    m: u64,
    ranges: Vec<(u64, u64)>,
    peaks: &'a [Hash],
    appended: &'a [Hash],
}

impl<'a> Frontier<'a> {
    fn new(m: u64, peaks: &'a [Hash], appended: &'a [Hash]) -> Option<Self> {
        let ranges = peak_ranges(m);
        (ranges.len() == peaks.len()).then_some(Self {
            m,
            ranges,
            peaks,
            appended,
        })
    }

    fn size(&self) -> Option<u64> {
        self.m.checked_add(self.appended.len() as u64)
    }

    /// MTH(D[lo:hi]), splitting as the tree does until each part is a peak or lies wholly in
    /// the appended leaves. That covers every subtree a consistency proof or a root needs: going
    /// down from a node that crosses m (or ends at it), the first node wholly inside the old log
    /// is a peak, since peaks are the largest perfect subtrees there. A node strictly inside a
    /// peak would bottom out in a single old leaf and give `None`; no caller asks for one.
    fn mth(&self, lo: u64, hi: u64) -> Option<Hash> {
        if lo >= self.m {
            let (a, b) = ((lo - self.m) as usize, (hi - self.m) as usize);
            return self.appended.get(a..b).map(root);
        }
        if let Some(i) = self.ranges.iter().position(|&r| r == (lo, hi)) {
            return Some(self.peaks[i]);
        }
        if hi - lo < 2 {
            return None;
        }
        let k = split(hi - lo);
        Some(node(&self.mth(lo, lo + k)?, &self.mth(lo + k, hi)?))
    }
}

/// The consistency proof from size `m` to `m + appended.len()`, from the peaks at `m` (largest
/// first, as `peaks` returns them) and the leaf hashes appended since. Equal to
/// `consistency_proof(all_leaves, m)`. `None` if `peaks` does not fit `m`.
pub fn consistency_proof_from_frontier(m: u64, peaks: &[Hash], appended: &[Hash]) -> Option<Vec<Hash>> {
    let f = Frontier::new(m, peaks, appended)?;
    let n = f.size()?;
    let mut out = Vec::new();
    if m > 0 {
        subproof(m, 0, n, true, &|a, b| f.mth(a, b), &mut out)?;
    }
    Some(out)
}

/// Root of the log after `appended`, from the peaks at `m`. `None` if `peaks` does not fit `m`.
pub fn root_from_frontier(m: u64, peaks: &[Hash], appended: &[Hash]) -> Option<Hash> {
    let f = Frontier::new(m, peaks, appended)?;
    match f.size()? {
        0 => Some(empty_root()),
        n => f.mth(0, n),
    }
}

pub fn verify_consistency(m: u64, n: u64, old_root: &Hash, new_root: &Hash, proof: &[Hash]) -> bool {
    verify_consistency_with(sha256_one, m, n, old_root, new_root, proof)
}

/// RFC 9162 §2.1.4.2: is the tree of size `m` with `old_root` a prefix of the tree of size `n`
/// with `new_root`? Size 0 is a prefix of every tree (its root must be the empty root), and
/// m == n needs an empty proof and equal roots.
pub fn verify_consistency_with<H: Fn(&[u8]) -> Hash>(
    hash: H,
    m: u64,
    n: u64,
    old_root: &Hash,
    new_root: &Hash,
    proof: &[Hash],
) -> bool {
    if m > n {
        return false;
    }
    if m == 0 {
        return proof.is_empty() && *old_root == hash(&[]);
    }
    if m == n {
        return proof.is_empty() && old_root == new_root;
    }
    let mut path = proof.iter();
    // When m is a power of two the old tree is one subtree of the new one, and the proof leaves
    // out its root because the verifier already has it.
    let first = if m.is_power_of_two() {
        old_root
    } else {
        match path.next() {
            Some(h) => h,
            None => return false,
        }
    };
    let (mut f, mut s) = (m - 1, n - 1);
    while f & 1 == 1 {
        f >>= 1;
        s >>= 1;
    }
    let (mut fr, mut sr) = (*first, *first);
    for c in path {
        if s == 0 {
            return false;
        }
        if f & 1 == 1 || f == s {
            fr = node_with(&hash, c, &fr);
            sr = node_with(&hash, c, &sr);
            while f & 1 == 0 && f != 0 {
                f >>= 1;
                s >>= 1;
            }
        } else {
            sr = node_with(&hash, &sr, c);
        }
        f >>= 1;
        s >>= 1;
    }
    &fr == old_root && &sr == new_root && s == 0
}
