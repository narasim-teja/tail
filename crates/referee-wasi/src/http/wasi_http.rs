//! The OutLayer backend of `http`: raw `wasi:http` with a hard deadline. The Handler voice must
//! give up after its budget, and `wasi-http-client` can only bound the connect. Waiting is a
//! `poll` on the response (or the body stream) together with a monotonic-clock timer.

use super::{Error, Response};
use wasi::clocks::monotonic_clock;
use wasi::http::outgoing_handler;
use wasi::http::types::{Fields, OutgoingBody, OutgoingRequest, Scheme};
use wasi::io::poll;
use wasi::io::streams::StreamError;

pub use wasi::http::types::Method;

/// Responses we read are a few KB; anything far larger is not the API we called.
const MAX_BODY: usize = 256 * 1024;
/// `blocking-write-and-flush` takes at most 4096 bytes per call (wasi:io).
const WRITE_CHUNK: usize = 4096;

fn other(what: &str) -> impl Fn(()) -> Error + '_ {
    move |()| Error::Other(format!("http: {what} failed"))
}

/// Monotonic deadline `ms` from now, in the clock's nanoseconds.
pub fn deadline_in(ms: u64) -> u64 {
    monotonic_clock::now().saturating_add(ms.saturating_mul(1_000_000))
}

pub fn passed(deadline: u64) -> bool {
    monotonic_clock::now() >= deadline
}

/// Blocks until `ms` have passed (retry spacing).
pub fn sleep_ms(ms: u64) {
    monotonic_clock::subscribe_duration(ms.saturating_mul(1_000_000)).block();
}

/// Waits on `p` until it is ready or the deadline passes; true if ready.
fn wait(p: &poll::Pollable, deadline: u64) -> bool {
    if p.ready() {
        return true;
    }
    if passed(deadline) {
        return false;
    }
    let timer = monotonic_clock::subscribe_instant(deadline);
    poll::poll(&[p, &timer]);
    p.ready()
}

/// One HTTPS request to `authority` + `path`, finished (headers and whole body) by `deadline`.
pub fn request(
    method: &Method,
    authority: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    deadline: u64,
) -> Result<Response, Error> {
    let fields: Vec<(String, Vec<u8>)> = headers
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.as_bytes().to_vec()))
        .collect();
    let fields =
        Fields::from_list(&fields).map_err(|e| Error::Other(format!("http: header rejected: {e:?}")))?;
    let req = OutgoingRequest::new(fields);
    req.set_method(method).map_err(other("set method"))?;
    req.set_scheme(Some(&Scheme::Https))
        .map_err(other("set scheme"))?;
    req.set_authority(Some(authority))
        .map_err(other("set authority"))?;
    req.set_path_with_query(Some(path)).map_err(other("set path"))?;

    let out_body = req.body().map_err(other("open request body"))?;
    if let Some(bytes) = body {
        let stream = out_body.write().map_err(other("open request stream"))?;
        for chunk in bytes.chunks(WRITE_CHUNK) {
            stream
                .blocking_write_and_flush(chunk)
                .map_err(|e| Error::Other(format!("http: write body: {e:?}")))?;
        }
        // The stream is a child of the body and must be gone before the body is finished.
        drop(stream);
    }

    let future = outgoing_handler::handle(req, None).map_err(|e| Error::Other(format!("http: {e}")))?;
    OutgoingBody::finish(out_body, None).map_err(|e| Error::Other(format!("http: finish body: {e}")))?;

    let ready = {
        let p = future.subscribe();
        wait(&p, deadline)
    };
    if !ready {
        return Err(Error::Timeout);
    }
    let incoming = future
        .get()
        .ok_or(Error::Timeout)?
        .map_err(other("take response"))?
        .map_err(|e| Error::Other(format!("http: {e}")))?;
    let status = incoming.status();
    let in_body = incoming.consume().map_err(other("open response body"))?;
    let body = {
        let stream = in_body.stream().map_err(other("open response stream"))?;
        let mut buf = Vec::new();
        loop {
            match stream.read(64 * 1024) {
                Ok(chunk) if chunk.is_empty() => {
                    let p = stream.subscribe();
                    if !wait(&p, deadline) {
                        return Err(Error::Timeout);
                    }
                }
                Ok(chunk) => {
                    buf.extend_from_slice(&chunk);
                    if buf.len() > MAX_BODY {
                        return Err(Error::Other(format!("http: response over {MAX_BODY} bytes")));
                    }
                }
                Err(StreamError::Closed) => break,
                Err(StreamError::LastOperationFailed(e)) => {
                    return Err(Error::Other(format!("http: read body: {}", e.to_debug_string())))
                }
            }
        }
        buf
    };
    Ok(Response { status, body })
}
