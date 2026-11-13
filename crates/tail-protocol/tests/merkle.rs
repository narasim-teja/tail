//! Merkle roots, inclusion and consistency proofs against an independent reference, for every
//! log size up to 70.

use std::cell::Cell;
use tail_protocol::digest::sha256;
use tail_protocol::merkle::{
    consistency_proof, consistency_proof_from_frontier, empty_root, node, peaks, proof, root,
    root_from_frontier, sha256_one, verify, verify_consistency, verify_consistency_with, verify_with,
};
use tail_protocol::Hash;

const MAX: usize = 70;

fn leaves() -> Vec<Hash> {
    (0..MAX)
        .map(|i| sha256(&[format!("leaf {i}").as_bytes()]))
        .collect()
}

/// The tree built level by level, an odd node carried up unchanged: the same tree as RFC 6962's
/// largest-power-of-two split, built a different way.
fn naive_root(ls: &[Hash]) -> Hash {
    if ls.is_empty() {
        return empty_root();
    }
    let mut level = ls.to_vec();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|c| if let [l, r] = c { node(l, r) } else { c[0] })
            .collect();
    }
    level[0]
}

fn flip(h: &Hash) -> Hash {
    let mut c = *h;
    c[0] ^= 1;
    c
}

#[test]
fn roots_peaks_and_audit_paths_match_the_reference() {
    let ls = leaves();
    for n in 0..=MAX {
        let r = naive_root(&ls[..n]);
        assert_eq!(root(&ls[..n]), r, "root {n}");
        assert_eq!(peaks(&ls[..n]).len(), n.count_ones() as usize);
        assert_eq!(root_from_frontier(0, &[], &ls[..n]), Some(r));
        for i in 0..n {
            let p = proof(&ls[..n], i);
            let (i64_, n64) = (i as u64, n as u64);
            assert!(verify(&ls[i], i64_, n64, &p, &r), "leaf {i} of {n}");
            assert!(!verify(&flip(&ls[i]), i64_, n64, &p, &r));
            if n > 1 {
                assert!(!verify(&ls[i], ((i + 1) % n) as u64, n64, &p, &r));
            }
            if !p.is_empty() {
                assert!(!verify(&ls[i], i64_, n64, &p[1..], &r));
            }
        }
    }
}

#[test]
fn consistency_for_every_pair_up_to_70() {
    let ls = leaves();
    let roots: Vec<Hash> = (0..=MAX).map(|n| naive_root(&ls[..n])).collect();
    for n in 1..=MAX {
        for m in 1..=n {
            let full = consistency_proof(&ls[..n], m);
            let pk = peaks(&ls[..m]);
            assert_eq!(
                consistency_proof_from_frontier(m as u64, &pk, &ls[m..n]).as_ref(),
                Some(&full),
                "frontier {m} → {n}"
            );
            assert_eq!(root_from_frontier(m as u64, &pk, &ls[m..n]), Some(roots[n]));

            let (mu, nu) = (m as u64, n as u64);
            let (old, new) = (roots[m], roots[n]);
            assert!(verify_consistency(mu, nu, &old, &new, &full), "{m} → {n}");
            assert!(!verify_consistency(mu, nu, &flip(&old), &new, &full));
            assert!(!verify_consistency(mu, nu, &old, &flip(&new), &full));
            if m < n {
                assert!(!verify_consistency(mu, nu, &old, &new, &full[..full.len() - 1]));
                let mut longer = full.clone();
                longer.push(old);
                assert!(!verify_consistency(mu, nu, &old, &new, &longer));
                for i in 0..full.len() {
                    let mut bad = full.clone();
                    bad[i] = flip(&bad[i]);
                    assert!(
                        !verify_consistency(mu, nu, &old, &new, &bad),
                        "{m} → {n} element {i}"
                    );
                }
            }
        }
    }
}

#[test]
fn a_rewritten_old_log_is_not_consistent() {
    let ls = leaves();
    for (m, n) in [(3, 7), (8, 13), (13, 70)] {
        let mut rewritten = ls[..n].to_vec();
        rewritten[m - 1] = flip(&rewritten[m - 1]);
        let p = consistency_proof(&rewritten, m);
        assert!(!verify_consistency(
            m as u64,
            n as u64,
            &root(&ls[..m]),
            &root(&rewritten),
            &p
        ));
    }
}

#[test]
fn edge_cases() {
    let ls = leaves();
    let r9 = root(&ls[..9]);
    assert!(verify_consistency(0, 9, &empty_root(), &r9, &[]));
    assert!(!verify_consistency(0, 9, &root(&ls[..1]), &r9, &[]));
    assert!(!verify_consistency(5, 4, &root(&ls[..5]), &root(&ls[..4]), &[]));
    assert_eq!(consistency_proof_from_frontier(5, &peaks(&ls[..4]), &[]), None);
    assert_eq!(consistency_proof_from_frontier(0, &[], &ls[..3]), Some(vec![]));
    assert!(!verify(&ls[0], 3, 3, &[], &ls[0]));
}

#[test]
fn the_hash_is_pluggable() {
    let ls = leaves();
    let calls = Cell::new(0u32);
    let counting = |b: &[u8]| {
        calls.set(calls.get() + 1);
        sha256_one(b)
    };
    let (m, n) = (13, 70);
    let p = consistency_proof(&ls[..n], m);
    assert!(verify_consistency_with(
        counting,
        m as u64,
        n as u64,
        &root(&ls[..m]),
        &root(&ls[..n]),
        &p
    ));
    assert!(calls.get() > 0);
    let before = calls.get();
    let ip = proof(&ls[..n], 5);
    assert!(verify_with(counting, &ls[5], 5, n as u64, &ip, &root(&ls[..n])));
    assert_eq!(calls.get() - before, ip.len() as u32);
    // A different hash function gives a different tree, so nothing verifies across them.
    let other = |b: &[u8]| sha256(&[b"other", b]);
    assert!(!verify_with(other, &ls[5], 5, n as u64, &ip, &root(&ls[..n])));
}
