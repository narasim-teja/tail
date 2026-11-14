//! Minimal HTTPS client for the Handler voice, with a hard deadline. Two backends export the
//! same functions, chosen by target like `host`:
//! - `wasi_http` (wasm): raw `wasi:http` inside the enclave.
//! - `native`: the local test referee, `ureq` over rustls, making the same calls.

use std::fmt::Write as _;

#[cfg(target_family = "wasm")]
mod wasi_http;
#[cfg(target_family = "wasm")]
pub use wasi_http::*;

#[cfg(not(target_family = "wasm"))]
mod native;
#[cfg(not(target_family = "wasm"))]
pub use native::*;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum Error {
    /// The deadline passed before the whole response arrived.
    Timeout,
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Timeout => f.write_str("timed out"),
            Error::Other(s) => f.write_str(s),
        }
    }
}

/// Percent-encodes a query or path component (RFC 3986 unreserved characters pass).
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            write!(out, "%{b:02X}").expect("writing to a String cannot fail");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_model_ids() {
        assert_eq!(
            super::encode_component("deepseek-ai/DeepSeek-V4.1-Flash-1017"),
            "deepseek-ai%2FDeepSeek-V4.1-Flash-1017"
        );
    }
}
