//! The Dossier card, built on every `nft_token` read: the Rust twin of `dossierSvg` in
//! `packages/brand/src/dossier.ts`, which documents the picture. Both must produce the same bytes
//! for the same view; `packages/brand/vectors/dossier.json` pins that and both sides test it.
//! Integers only (every coordinate is an `i32`, every division truncates toward zero, like
//! `Math.trunc`), so nothing depends on float formatting.
// Geometry reads best in the TypeScript twin's short names (s for seed, w for waypoints, c for
// control points, p, q, x, y); keeping them the same makes the two easy to compare line by line.
#![allow(clippy::many_single_char_names)]

use std::fmt::Write;

use crate::dossier::{DossierView, MatchResult, DOSSIER_ENTRIES};

const W: i32 = 400;
const H: i32 = 500;
// `packages/brand` colours and the Trail mark's geometry.
const PERSIMMON: &str = "#EE6A3F";
const DUSK: &str = "#1C2430";
const INK: &str = "#F1ECE5";
const TRAIL_TAIL: &str = "M33.8 11.8 Q14 30 7 57 Q30 46 52.2 30.2 Z";
const SANS: &str = "system-ui,sans-serif";
const MONO: &str = "ui-monospace,Menlo,monospace";

/// Route waypoints before jitter: rows of 5, 4 and 4, bottom to top, snaking.
const BASE: [(i32, i32); 13] = [
    (64, 320),
    (132, 320),
    (200, 320),
    (268, 320),
    (336, 320),
    (312, 232),
    (236, 232),
    (164, 232),
    (88, 232),
    (88, 144),
    (164, 144),
    (236, 144),
    (312, 144),
];

/// cos and sin of the eight compass points, times 1000.
const DIRS: [(i32, i32); 8] = [
    (1000, 0),
    (707, 707),
    (0, 1000),
    (-707, 707),
    (-1000, 0),
    (-707, -707),
    (0, -1000),
    (707, -707),
];

type Pt = (i32, i32);

fn pt(p: Pt) -> String {
    format!("{} {}", p.0, p.1)
}

/// A relative pair; a minus sign separates the numbers by itself.
fn rel(dx: i32, dy: i32) -> String {
    if dy < 0 {
        format!("{dx}{dy}")
    } else {
        format!("{dx} {dy}")
    }
}

/// The 13 waypoints and the 12 control points of the route.
fn route(s: &[u8; 32]) -> ([Pt; 13], [Pt; DOSSIER_ENTRIES]) {
    let mirror = s[31] >= 128;
    let mut w = [(0, 0); 13];
    for (k, &(x, y)) in BASE.iter().enumerate() {
        let jx = x + i32::from(s[k] % 33) - 16;
        let jy = y + i32::from(s[k + 13] % 33) - 16;
        w[k] = (if mirror { W - jx } else { jx }, jy);
    }
    let mut c = [(0, 0); DOSSIER_ENTRIES];
    for (k, ck) in c.iter_mut().enumerate() {
        let (a, b) = (w[k], w[k + 1]);
        let byte = s[26 + (k >> 1)];
        let nibble = if k % 2 == 0 { byte & 15 } else { byte >> 4 };
        let bend = i32::from(nibble) * 4 - 30;
        let (mx, my) = (i32::midpoint(a.0, b.0), i32::midpoint(a.1, b.1));
        *ck = if (b.0 - a.0).abs() >= (b.1 - a.1).abs() {
            (mx, my + bend)
        } else {
            // A turn between rows bulges outward, away from the middle of the card.
            let out = if mx > W / 2 { bend.abs() } else { -bend.abs() };
            ((mx + out).clamp(16, W - 16), my)
        };
    }
    (w, c)
}

/// Three closed contour loops, quadratic curves through the midpoints of 8 jittered points.
fn contours(s: &[u8; 32]) -> String {
    let cx = 150 + i32::from(s[24] % 101);
    let cy = 210 + i32::from(s[25] % 41);
    let mut d = String::new();
    for (lp, base) in [40, 80, 120].into_iter().enumerate() {
        let mut p = [(0, 0); 8];
        for (j, &(ux, uy)) in DIRS.iter().enumerate() {
            let r = base + i32::from(s[(lp * 8 + j) % 32] % 21) - 10;
            p[j] = (cx + r * ux / 1000, cy + r * uy * 3 / 4000);
        }
        let mid = |j: usize| {
            let (a, b) = (p[j % 8], p[(j + 1) % 8]);
            (i32::midpoint(a.0, b.0), i32::midpoint(a.1, b.1))
        };
        let _ = write!(d, "M{}", pt(mid(7)));
        for (j, &pj) in p.iter().enumerate() {
            let _ = write!(d, "Q{} {}", pt(pj), pt(mid(j)));
        }
        d.push('Z');
    }
    d
}

/// Segments `ks` of the route as one path's `d`, joining runs that continue each other.
fn segments(ks: &[usize], w: &[Pt; 13], c: &[Pt; DOSSIER_ENTRIES]) -> String {
    let mut d = String::new();
    let mut last: Option<usize> = None;
    for &k in ks {
        if last.is_none_or(|l| l + 1 != k) {
            let _ = write!(d, "M{}", pt(w[k]));
        }
        let _ = write!(d, "Q{} {}", pt(c[k]), pt(w[k + 1]));
        last = Some(k);
    }
    d
}

fn stroke(d: &str, attrs: &str) -> String {
    if d.is_empty() {
        String::new()
    } else {
        format!(r#"<path d="{d}" fill="none" stroke="{INK}" {attrs}/>"#)
    }
}

fn count(v: u32, label: &str) -> String {
    format!(r#"<tspan font-weight="700" fill-opacity="1">{v}</tspan> {label}"#)
}

/// The Dossier card for `v`. `v.seed` is the hex SHA-256 the contract computed itself.
#[allow(clippy::too_many_lines)]
pub fn dossier_svg(v: &DossierView) -> String {
    let mut s = [0u8; 32];
    hex::decode_to_slice(&v.seed, &mut s).expect("the contract writes a 32-byte seed");
    let (w, c) = route(&s);
    // Oldest first: the route is walked in the order the matches settled.
    let entries: Vec<_> = v.entries.iter().take(DOSSIER_ENTRIES).rev().collect();
    let n = entries.len();

    let mut walked = String::new();
    // Three age bands, newest brightest: the trail fades behind the head, like the mark's.
    for (band, opacity) in [(2, ".3"), (1, ".55"), (0, ".9")] {
        let ks: Vec<usize> = (0..n)
            .filter(|&k| entries[k].result != MatchResult::Refunded && (n - 1 - k) / 4 == band)
            .collect();
        walked += &stroke(
            &segments(&ks, &w, &c),
            &format!(r#"stroke-opacity="{opacity}" stroke-width="2.5" stroke-linecap="round""#),
        );
    }
    let refunded: Vec<usize> = (0..n)
        .filter(|&k| entries[k].result == MatchResult::Refunded)
        .collect();
    let ahead: Vec<usize> = (n..DOSSIER_ENTRIES).collect();

    let (mut ticks, mut won, mut rings, mut slashes, mut grey) = (
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
    );
    // Each tick is a move then an 8-unit stroke; after the first, the move is relative.
    let mut pen: Option<Pt> = None;
    for (k, e) in entries.iter().enumerate() {
        let (a, b, q) = (w[k], w[k + 1], c[k]);
        let flat = (b.0 - a.0).abs() >= (b.1 - a.1).abs();
        let t = if e.result == MatchResult::Refunded {
            0
        } else {
            // At most 11 (one per other player), so this never saturates in practice.
            i32::try_from(e.tags).unwrap_or(i32::MAX)
        };
        for i in 1..=t {
            // The point at i/(t+1) along the segment's quadratic curve.
            let m = t + 1;
            let (u, vv, z) = ((m - i) * (m - i), 2 * i * (m - i), i * i);
            let x = (u * a.0 + vv * q.0 + z * b.0) / (m * m);
            let y = (u * a.1 + vv * q.1 + z * b.1) / (m * m);
            let start = if flat { (x, y - 4) } else { (x - 4, y) };
            let _ = match pen {
                Some(p) => write!(ticks, "m{}", rel(start.0 - p.0, start.1 - p.1)),
                None => write!(ticks, "M{}", pt(start)),
            };
            ticks += if flat { "v8" } else { "h8" };
            pen = Some(if flat {
                (start.0, start.1 + 8)
            } else {
                (start.0 + 8, start.1)
            });
        }
        let dot = |r: i32| format!(r#"<circle cx="{}" cy="{}" r="{r}"/>"#, b.0, b.1);
        match e.result {
            MatchResult::Survived => won += &dot(5),
            MatchResult::Refunded => grey += &dot(3),
            MatchResult::Tagged | MatchResult::Forfeit => {
                rings += &dot(5);
                if e.result == MatchResult::Forfeit {
                    let _ = write!(slashes, "M{} {}l6-6", b.0 - 3, b.1 + 3);
                }
            }
        }
    }

    let head = w[n];
    let from = w[n.saturating_sub(1)];
    let to = if n == 0 { w[1] } else { head };
    // The mark faces north-east; flipped, north-west. Its trail's tip lands on the head.
    let flip = to.0 < from.0;
    let mark = format!(
        r#"<g transform="translate({} {}) scale({} .75)" fill="{PERSIMMON}"><path d="{TRAIL_TAIL}" fill-opacity=".38"/><circle cx="43" cy="21" r="13"/></g>"#,
        if flip { head.0 + 5 } else { head.0 - 5 },
        head.1 - 43,
        if flip { "-.75" } else { ".75" },
    );

    // NEAR account ids are lowercase letters, digits and `-_.`: nothing in them needs escaping.
    let handle = v.account_id.as_str().split('.').next().unwrap_or_default();
    // A NEAR account id is at most 64 characters, so the length always fits.
    let fs = 34.min(600 / i32::try_from(handle.len().max(1)).unwrap_or(i32::MAX));
    let file = v.seed[..8].to_ascii_uppercase();

    let mut out = String::with_capacity(4096);
    let _ = write!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="TAIL dossier">"#
    );
    let _ = write!(
        out,
        r#"<path d="M0 56V20Q0 0 20 0H128Q140 0 146 10L154 26Q160 36 174 36H380Q400 36 400 56V480Q400 500 380 500H20Q0 500 0 480Z" fill="{DUSK}"/>"#
    );
    out += &stroke(&contours(&s), r#"stroke-opacity=".07""#);
    out += &stroke(
        &segments(&ahead, &w, &c),
        r#"stroke-opacity=".2" stroke-width="2" stroke-dasharray="0 7" stroke-linecap="round""#,
    );
    out += &stroke(
        &segments(&refunded, &w, &c),
        r#"stroke-opacity=".32" stroke-width="2" stroke-dasharray="5 5""#,
    );
    out += &walked;
    let _ = write!(
        out,
        r#"<circle cx="{}" cy="{}" r="3" fill="{INK}" fill-opacity=".5"/>"#,
        w[0].0, w[0].1
    );
    if !ticks.is_empty() {
        let _ = write!(
            out,
            r#"<path d="{ticks}" stroke="{PERSIMMON}" stroke-width="2" stroke-linecap="round"/>"#
        );
    }
    if !won.is_empty() {
        let _ = write!(out, r#"<g fill="{PERSIMMON}">{won}</g>"#);
    }
    if !rings.is_empty() {
        let slash = if slashes.is_empty() {
            String::new()
        } else {
            format!(r#"<path d="{slashes}"/>"#)
        };
        let _ = write!(
            out,
            r#"<g fill="{DUSK}" stroke="{INK}" stroke-width="2">{rings}{slash}</g>"#
        );
    }
    if !grey.is_empty() {
        let _ = write!(out, r#"<g fill="{INK}" fill-opacity=".32">{grey}</g>"#);
    }
    out += &mark;
    let _ = write!(
        out,
        concat!(
            r#"<g font-family="{SANS}" fill="{INK}">"#,
            r#"<text x="24" y="24" font-size="11" font-weight="600" letter-spacing="3" fill-opacity=".6">DOSSIER</text>"#,
            r#"<text x="376" y="66" text-anchor="end" font-family="{MONO}" font-size="11" letter-spacing="1" fill-opacity=".45">FILE {file}</text>"#,
            r#"<path d="M24 372H376" stroke="{INK}" stroke-opacity=".14"/>"#,
            r#"<text x="24" y="416" font-size="{fs}" font-weight="700">{handle}</text>"#,
            r#"<text x="24" y="446" font-size="14" fill-opacity=".7">{matches} · {survived} · {tags}</text>"#,
            r#"<g transform="translate(24 460) scale(.67)" fill="none" stroke="{INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".7"><circle cx="12" cy="12" r="9"/><path d="M8 12.5L11 15.5L16.5 9"/></g>"#,
            r#"<text x="46" y="474" font-size="12" fill-opacity=".7">verified on NEAR</text>"#,
            "</g></svg>"
        ),
        SANS = SANS,
        INK = INK,
        MONO = MONO,
        file = file,
        fs = fs,
        handle = handle,
        matches = count(v.matches, "matches"),
        survived = count(v.survived, "survived"),
        tags = count(v.tags, "tags"),
    );
    out
}
