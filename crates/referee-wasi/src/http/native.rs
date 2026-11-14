//! The native backend of `http`: the local test referee's HTTPS client, `ureq` over rustls.
//! It makes the same calls the enclave makes, with the same deadline: the Handler line is real
//! NEAR AI output with its TEE signature, but the process that asked and signs it is a
//! developer's, not an enclave, so nothing attests what it sent.
//!
//! Kept to what `wasi:http` does in the enclave: no redirects followed, no compression asked
//! for (the TEE signature hashes the response body as sent), and every status returned as a
//! response for the caller to judge.

use super::{Error, Response};
use crate::host::monotonic_ns;
use std::time::Duration;

/// The request methods the Handler voice uses (passed by reference, as `wasi:http`'s are).
#[derive(Debug)]
pub enum Method {
    Get,
    Post,
}

/// Responses we read are a few KB; anything far larger is not the API we called.
const MAX_BODY: u64 = 256 * 1024;

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

/// One HTTPS request to `authority` + `path`, finished (headers and whole body) by `deadline`.
pub fn request(
    method: &Method,
    authority: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    deadline: u64,
) -> Result<Response, Error> {
    send(
        method,
        &format!("https://{authority}{path}"),
        headers,
        body,
        deadline,
    )
}

/// `request` on a whole URL, so the tests can talk plain HTTP to a local listener.
fn send(
    method: &Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    deadline: u64,
) -> Result<Response, Error> {
    // ureq's global timeout covers DNS, connect, TLS, sending and reading the whole body.
    let left = deadline.saturating_sub(monotonic_ns());
    if left == 0 {
        return Err(Error::Timeout);
    }
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_nanos(left)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .new_agent();
    let mut req = match method {
        Method::Get => ureq::http::Request::get(url),
        Method::Post => ureq::http::Request::post(url),
    };
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let rejected = |e: ureq::http::Error| Error::Other(format!("http: request rejected: {e}"));
    // No body at all (not an empty one) on the GET, as in the enclave.
    let mut resp = match body {
        Some(bytes) => agent.run(req.body(bytes).map_err(rejected)?),
        None => agent.run(req.body(()).map_err(rejected)?),
    }
    .map_err(error)?;
    let status = resp.status().as_u16();
    let body = resp
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_vec()
        .map_err(error)?;
    Ok(Response { status, body })
}

fn error(e: ureq::Error) -> Error {
    match e {
        ureq::Error::Timeout(_) => Error::Timeout,
        ureq::Error::BodyExceedsLimit(_) => Error::Other(format!("http: response over {MAX_BODY} bytes")),
        e => Error::Other(format!("http: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{deadline_in, send, Error, Method};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::{Duration, Instant};

    /// A listener on a free local port; `serve` gets each accepted connection.
    fn listen(serve: impl FnOnce(TcpStream) + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            serve(conn);
        });
        format!("http://{addr}")
    }

    /// Reads one request (head and `content-length` body); returns its head, lowercased.
    fn read_request(conn: &mut TcpStream) -> String {
        let mut got = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            let n = conn.read(&mut buf).unwrap();
            got.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&got).to_ascii_lowercase();
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .map_or(0, |v| v.trim().parse::<usize>().unwrap());
                if got.len() >= end + 4 + len {
                    return text[..end].to_owned();
                }
            }
            assert!(n > 0, "the client closed before sending its request");
        }
    }

    /// Reads one request, then writes `answer`.
    fn answer_with(answer: impl AsRef<[u8]> + Send + 'static) -> impl FnOnce(TcpStream) + Send + 'static {
        move |mut conn| {
            read_request(&mut conn);
            // The client may hang up first (a body over the cap); that is its business.
            let _ = conn.write_all(answer.as_ref());
        }
    }

    #[test]
    fn gives_up_at_the_deadline_when_the_server_never_answers() {
        let url = listen(|conn| {
            // Holds the connection open and says nothing until the test is long over.
            thread::sleep(Duration::from_secs(30));
            drop(conn);
        });
        let t0 = Instant::now();
        let r = send(
            &Method::Post,
            &format!("{url}/v1/chat/completions"),
            &[],
            Some(b"{}"),
            deadline_in(300),
        );
        let took = t0.elapsed();
        assert!(matches!(r, Err(Error::Timeout)), "{r:?}");
        assert!(took >= Duration::from_millis(250), "gave up early: {took:?}");
        assert!(took < Duration::from_secs(3), "overran the deadline: {took:?}");
    }

    #[test]
    fn a_deadline_already_passed_sends_nothing() {
        let r = send(&Method::Get, "http://127.0.0.1:9/", &[], None, deadline_in(0));
        assert!(matches!(r, Err(Error::Timeout)), "{r:?}");
    }

    #[test]
    fn returns_the_status_and_whole_body() {
        let url = listen(answer_with(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 16\r\nconnection: close\r\n\r\n{\"id\":\"chat-1\"}\n",
        ));
        let r = send(
            &Method::Post,
            &format!("{url}/v1/chat/completions"),
            &[
                ("authorization", "Bearer k"),
                ("content-type", "application/json"),
            ],
            Some(br#"{"model":"m"}"#),
            deadline_in(3_000),
        )
        .unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"{\"id\":\"chat-1\"}\n");
    }

    #[test]
    fn an_error_status_is_a_response_not_an_error() {
        // The signature lookup retries on 404, and the voice reports `HTTP {status}`: both need
        // the status, as `wasi:http` gives it.
        let url = listen(answer_with(
            "HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot found",
        ));
        let r = send(
            &Method::Get,
            &format!("{url}/v1/signature/x"),
            &[],
            None,
            deadline_in(3_000),
        )
        .unwrap();
        assert_eq!(r.status, 404);
        assert_eq!(r.body, b"not found");
    }

    #[test]
    fn a_redirect_is_returned_not_followed() {
        let url = listen(answer_with(
            "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        ));
        let r = send(&Method::Get, &format!("{url}/"), &[], None, deadline_in(3_000)).unwrap();
        assert_eq!(r.status, 302);
    }

    #[test]
    fn a_body_that_drips_in_past_the_deadline_times_out() {
        // The head arrives at once; the body a byte at a time, never finishing in time.
        let url = listen(|mut conn| {
            read_request(&mut conn);
            conn.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\n")
                .unwrap();
            while conn.write_all(b"x").is_ok() {
                thread::sleep(Duration::from_millis(50));
            }
        });
        let t0 = Instant::now();
        let r = send(
            &Method::Get,
            &format!("{url}/v1/signature/x"),
            &[],
            None,
            deadline_in(400),
        );
        let took = t0.elapsed();
        assert!(matches!(r, Err(Error::Timeout)), "{r:?}");
        assert!(took < Duration::from_secs(3), "overran the deadline: {took:?}");
    }

    #[test]
    fn a_body_over_the_cap_is_refused() {
        let len = usize::try_from(super::MAX_BODY).unwrap() + 1;
        let mut answer =
            format!("HTTP/1.1 200 OK\r\ncontent-length: {len}\r\nconnection: close\r\n\r\n").into_bytes();
        answer.resize(answer.len() + len, b'x');
        let url = listen(answer_with(answer));
        let r = send(&Method::Get, &format!("{url}/"), &[], None, deadline_in(3_000));
        assert!(matches!(&r, Err(Error::Other(e)) if e.contains("over")), "{r:?}");
    }

    #[test]
    fn asks_for_no_compression_and_returns_the_body_as_sent() {
        // NEAR AI signs sha256 of the response body as sent: a client that asked for gzip and
        // inflated it would hash other bytes than the ones signed.
        let (tx, rx) = std::sync::mpsc::channel();
        let raw: &[u8] = b"\x1f\x8b\x08\x00not-really-gzip";
        let url = listen(move |mut conn| {
            tx.send(read_request(&mut conn)).unwrap();
            let mut answer = format!(
                "HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                raw.len()
            )
            .into_bytes();
            answer.extend_from_slice(raw);
            conn.write_all(&answer).unwrap();
        });
        let r = send(&Method::Get, &format!("{url}/"), &[], None, deadline_in(3_000)).unwrap();
        assert!(!rx.recv().unwrap().contains("accept-encoding"));
        assert_eq!(r.body, raw);
    }
}
