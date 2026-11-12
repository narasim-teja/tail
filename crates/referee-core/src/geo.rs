//! Geometry on a local plane centred on the zone.
//!
//! Every position is projected once onto an equirectangular plane around the zone centre, so
//! distances, bearings and grid cells need only `+ − × ÷ sqrt`, which IEEE 754 defines exactly.
//! The referee therefore gives bit-identical answers natively, in wasm and in the replay. Inside
//! a city-sized zone the projection differs from haversine by well under 0.1 %.
// Coordinates are e7 integers (≤ 1.8e9), exactly representable in an f64; the casts back to
// i32 happen only for results that are inside the original coordinate range.
#![allow(clippy::cast_precision_loss)]

use borsh::{BorshDeserialize, BorshSerialize};
use std::f64::consts::PI;

/// Mean Earth radius (IUGG), metres.
const EARTH_RADIUS_M: f64 = 6_371_008.8;
/// Metres per 1e-7 degree of latitude.
const M_PER_E7: f64 = EARTH_RADIUS_M * PI / 180.0 / 1e7;
/// tan(22.5°) = √2 − 1: the sector edges of an 8-way compass.
const TAN_22_5: f64 = std::f64::consts::SQRT_2 - 1.0;

/// cos(x) for |x| ≤ π/2 by its Taylor series with a fixed number of terms, so every platform
/// computes the same bits (libm's `cos` is not guaranteed to agree across targets).
fn cos(x: f64) -> f64 {
    let x2 = x * x;
    let mut term = 1.0;
    let mut sum = 1.0;
    for k in 1..=14u32 {
        let k2 = f64::from(2 * k);
        term = -term * x2 / ((k2 - 1.0) * k2);
        sum += term;
    }
    sum
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    lat0_e7: i32,
    lon0_e7: i32,
    m_per_e7_lon: f64,
}

/// A position on the plane, metres east (`x`) and north (`y`) of the zone centre.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Plane {
    pub fn new(lat0_e7: i32, lon0_e7: i32) -> Self {
        let lat_rad = f64::from(lat0_e7) / 1e7 * PI / 180.0;
        Self {
            lat0_e7,
            lon0_e7,
            m_per_e7_lon: M_PER_E7 * cos(lat_rad),
        }
    }

    pub fn point(&self, lat_e7: i32, lon_e7: i32) -> Point {
        Point {
            x: (i64::from(lon_e7) - i64::from(self.lon0_e7)) as f64 * self.m_per_e7_lon,
            y: (i64::from(lat_e7) - i64::from(self.lat0_e7)) as f64 * M_PER_E7,
        }
    }

    /// The centre of the `cell_m` grid cell holding `p`, back in e7 degrees. The grid is anchored
    /// at the zone centre, so every leak in a match uses the same cells.
    pub fn cell_centre(&self, p: Point, cell_m: f64) -> (i32, i32) {
        let cx = ((p.x / cell_m).floor() + 0.5) * cell_m;
        let cy = ((p.y / cell_m).floor() + 0.5) * cell_m;
        let lat = i64::from(self.lat0_e7) + (cy / M_PER_E7).round() as i64;
        let lon = i64::from(self.lon0_e7) + (cx / self.m_per_e7_lon).round() as i64;
        (
            lat.clamp(-900_000_000, 900_000_000) as i32,
            lon.clamp(-1_800_000_000, 1_800_000_000) as i32,
        )
    }
}

pub fn distance(a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    (dx * dx + dy * dy).sqrt()
}

/// 8-way compass direction from `from` to `to`: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW.
/// The same point reads as N.
pub fn bearing8(from: Point, to: Point) -> u8 {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let (ax, ay) = (dx.abs(), dy.abs());
    if ax <= TAN_22_5 * ay || (ax == 0.0 && ay == 0.0) {
        if dy >= 0.0 {
            0
        } else {
            4
        }
    } else if ay <= TAN_22_5 * ax {
        if dx > 0.0 {
            2
        } else {
            6
        }
    } else {
        match (dx > 0.0, dy > 0.0) {
            (true, true) => 1,
            (true, false) => 3,
            (false, false) => 5,
            (false, true) => 7,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taylor_cosine_matches_libm_to_the_last_few_ulps() {
        for deg in [-89.9f64, -60.0, -42.35, 0.0, 10.0, 42.355, 60.0, 89.9] {
            let x = deg * PI / 180.0;
            assert!((cos(x) - x.cos()).abs() < 1e-15, "{deg}");
        }
    }

    #[test]
    fn one_hundred_metres_north_and_east_measure_one_hundred_metres() {
        // Boston Common.
        let plane = Plane::new(423_550_000, -710_660_000);
        let o = plane.point(423_550_000, -710_660_000);
        let north = plane.point(423_550_000 + (100.0 / M_PER_E7).round() as i32, -710_660_000);
        assert!((distance(o, north) - 100.0).abs() < 0.01);
        let east_e7 = (100.0 / plane.m_per_e7_lon).round() as i32;
        let east = plane.point(423_550_000, -710_660_000 + east_e7);
        assert!((distance(o, east) - 100.0).abs() < 0.01);
    }

    #[test]
    fn the_plane_agrees_with_haversine_across_a_city_zone() {
        let plane = Plane::new(423_550_000, -710_660_000);
        let (a, b) = ((423_500_000, -710_700_000), (423_600_000, -710_600_000));
        let hav = {
            let (la1, lo1) = (
                f64::from(a.0) / 1e7 * PI / 180.0,
                f64::from(a.1) / 1e7 * PI / 180.0,
            );
            let (la2, lo2) = (
                f64::from(b.0) / 1e7 * PI / 180.0,
                f64::from(b.1) / 1e7 * PI / 180.0,
            );
            let h =
                ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
            2.0 * EARTH_RADIUS_M * h.sqrt().asin()
        };
        let d = distance(plane.point(a.0, a.1), plane.point(b.0, b.1));
        assert!((d - hav).abs() / hav < 1e-3, "{d} vs {hav}");
    }

    #[test]
    fn bearings_cover_all_eight_sectors() {
        let o = Point { x: 0.0, y: 0.0 };
        let cases = [
            ((0.0, 10.0), 0),
            ((10.0, 10.0), 1),
            ((10.0, 0.0), 2),
            ((10.0, -10.0), 3),
            ((0.0, -10.0), 4),
            ((-10.0, -10.0), 5),
            ((-10.0, 0.0), 6),
            ((-10.0, 10.0), 7),
            ((3.0, 10.0), 0),
            ((5.0, 10.0), 1),
        ];
        for ((x, y), want) in cases {
            assert_eq!(bearing8(o, Point { x, y }), want, "({x}, {y})");
        }
    }

    #[test]
    fn grid_cells_snap_nearby_points_together_and_split_far_ones() {
        let plane = Plane::new(423_550_000, -710_660_000);
        let a = plane.cell_centre(Point { x: 10.0, y: 10.0 }, 100.0);
        let b = plane.cell_centre(Point { x: 90.0, y: 60.0 }, 100.0);
        let c = plane.cell_centre(Point { x: 110.0, y: 10.0 }, 100.0);
        assert_eq!(a, b);
        assert_ne!(a, c);
        let centre = plane.point(a.0, a.1);
        assert!((centre.x - 50.0).abs() < 0.02 && (centre.y - 50.0).abs() < 0.02);
    }
}
