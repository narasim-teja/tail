//! The local backend of `http`: no network. The local test referee is a developer's process,
//! not the enclave whose manifest and attestation bound what it talks to, so it asks no model;
//! the Handler voice falls back to its template line and says why.

use super::{Error, Response};
use crate::host::monotonic_ns;
use std::time::Duration;

/// The request methods the Handler voice uses (passed by reference, as `wasi:http`'s are).
#[derive(Debug)]
pub enum Method {
    Get,
    Post,
}

/// Why the local test referee voices every hint with a template line.
const REASON: &str = "local test referee: no network, so no Handler model call (not an enclave)";
pub const OFFLINE: Option<&str> = Some(REASON);

/// Monotonic deadline `ms` from now, in nanoseconds.
pub fn deadline_in(ms: u64) -> u64 {
    monotonic_ns().saturating_add(ms.saturating_mul(1_000_000))
}

pub fn passed(deadline: u64) -> bool {
    monotonic_ns() >= deadline
}

/// Blocks until `ms` have passed (retry spacing).
pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Fails at once: there is no network here.
pub fn request(
    _method: &Method,
    _authority: &str,
    _path: &str,
    _headers: &[(&str, &str)],
    _body: Option<&[u8]>,
    _deadline: u64,
) -> Result<Response, Error> {
    Err(Error::Other(REASON.to_owned()))
}
