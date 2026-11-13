//! `voice`: one Handler line for a hint, from NEAR AI Cloud with its TEE signature, or a
//! template sentence when the model misses the 3 s budget.

use crate::codec::{b64, parse, to_borsh};
use crate::host;
use crate::http::{self, deadline_in, encode_component, passed, sleep_ms, Method};
use crate::voice::{self, ChatSignature, Fact};
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::digest::sha256;

const AUTHORITY: &str = "cloud-api.near.ai";
const DEFAULT_MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
/// TECHNICAL.md 4.7: over 3 s, use the template.
const COMPLETION_BUDGET_MS: u64 = 3_000;
/// The signature lookup can 404 until the right TEE node is found (F2); it does not hold up
/// the line itself, only the receipt.
const SIGNATURE_BUDGET_MS: u64 = 10_000;
const SIGNATURE_RETRY_MS: u64 = 500;

/// One hint from a tick's `hints` list: the referee computed the fact; this only voices it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    hint_id: u32,
    /// `hint_kind`: 0 NEAR, 1 BEARING, 2 TREND.
    hint: u8,
    /// The computed fact (`HintFact.value`).
    value: u8,
    #[serde(default)]
    question: Option<String>,
}

struct Completion {
    chat_id: String,
    text: String,
    request_sha: String,
    response_sha: String,
}

fn complete(key: &str, request: &[u8]) -> Result<Completion, String> {
    let auth = format!("Bearer {key}");
    let headers = [
        ("authorization", auth.as_str()),
        ("content-type", "application/json"),
        ("accept", "application/json"),
    ];
    let resp = http::request(
        &Method::Post,
        AUTHORITY,
        "/v1/chat/completions",
        &headers,
        Some(request),
        deadline_in(COMPLETION_BUDGET_MS),
    )
    .map_err(|e| e.to_string())?;
    if resp.status != 200 {
        return Err(format!("HTTP {}", resp.status));
    }
    let (chat_id, text) = voice::parse_completion(&resp.body)?;
    Ok(Completion {
        chat_id,
        text,
        request_sha: hex::encode(sha256(&[request])),
        response_sha: hex::encode(sha256(&[&resp.body])),
    })
}

fn fetch_signature(key: &str, model: &str, c: &Completion) -> Result<ChatSignature, String> {
    let auth = format!("Bearer {key}");
    let headers = [("authorization", auth.as_str()), ("accept", "application/json")];
    let path = format!(
        "/v1/signature/{}?model={}&signing_algo=ecdsa",
        c.chat_id,
        encode_component(model)
    );
    let deadline = deadline_in(SIGNATURE_BUDGET_MS);
    let mut last = String::from("no attempt");
    while !passed(deadline) {
        match http::request(&Method::Get, AUTHORITY, &path, &headers, None, deadline) {
            Ok(r) if r.status == 200 => {
                return voice::parse_signature(&r.body, &c.request_sha, &c.response_sha)
            }
            Ok(r) => last = format!("HTTP {}", r.status),
            Err(e) => last = e.to_string(),
        }
        sleep_ms(SIGNATURE_RETRY_MS);
    }
    Err(format!(
        "signature lookup did not succeed in {SIGNATURE_BUDGET_MS} ms (last: {last})"
    ))
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: Input = parse(input)?;
    let fact = Fact::new(i.hint, i.value)?;
    let question = i.question.as_deref().map(voice::clean_question).transpose()?;
    // A missing key or a refused model is a broken deployment, not a slow model: say so
    // instead of quietly serving templates. Without a network (the local test referee) no
    // model is asked, so no key is needed; `Err` carries why.
    let key: Result<String, &str> = match http::OFFLINE {
        Some(reason) => Err(reason),
        None => {
            Ok(host::author_secret("NEARAI_API_KEY").ok_or("the NEARAI_API_KEY author secret is not set")?)
        }
    };
    let model = host::author_secret("NEARAI_MODEL").unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    voice::check_model(&model)?;

    let request = voice::request_body(&model, fact, question.as_deref());
    let t0 = host::now_ms();
    let completion = match &key {
        Ok(key) => complete(key, &request).map(|c| (key, c)),
        Err(reason) => Err((*reason).to_owned()),
    };
    let latency_ms = host::now_ms() - t0;

    let (text, chat, fallback_reason, signature, signature_error) = match completion {
        Ok((key, c)) => {
            let (sig, err) = match fetch_signature(key, &model, &c) {
                Ok(s) => (Some(s), None),
                Err(e) => (None, Some(e)),
            };
            (c.text.clone(), Some(c), None, sig, err)
        }
        Err(reason) => (fact.template(), None, Some(reason), None, None),
    };
    let text_hash = sha256(&[text.as_bytes()]);

    // The relay passes this to the next tick (or to `end`), where the engine logs it. A
    // template line gets a receipt too: the log then shows which lines no model signed.
    let receipt = referee_core::HintReceipt {
        hint_id: i.hint_id,
        chat_id: chat.as_ref().map_or_else(String::new, |c| c.chat_id.clone()),
        text_hash,
        signature: match &signature {
            Some(s) => voice::signature_bytes(&s.signature)?,
            None => Vec::new(),
        },
        signing_address: signature
            .as_ref()
            .map_or_else(String::new, |s| s.signing_address.clone()),
    };

    Ok(json!({
        "text": text,
        "source": if chat.is_some() { "model" } else { "template" },
        "fact": fact.statement(),
        "model": model,
        "latency_ms": latency_ms,
        "fallback_reason": fallback_reason,
        "chat_id": chat.as_ref().map(|c| c.chat_id.clone()),
        "text_sha256": hex::encode(text_hash),
        "request_sha256": chat.as_ref().map(|c| c.request_sha.clone()),
        "response_sha256": chat.as_ref().map(|c| c.response_sha.clone()),
        "signature": signature.as_ref().map(|s| s.signature.clone()),
        "signing_address": signature.as_ref().map(|s| s.signing_address.clone()),
        "signature_kind": signature.as_ref().and_then(|s| s.signature_kind.clone()),
        "signed_text": signature.as_ref().map(|s| s.text.clone()),
        "signature_error": signature_error,
        "hint_id": i.hint_id,
        "receipt": b64(&to_borsh(&receipt)),
    }))
}
