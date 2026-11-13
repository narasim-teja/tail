//! `voice`: one Handler line for a hint, from NEAR AI Cloud with its TEE signature, or a
//! template sentence when the model misses the 3 s budget.
//!
//! The hint comes as the sealed blob `tick` returned, so the fact is the referee's own and the
//! relay never learns it. The line goes back signed and sealed to the asker, so the relay can
//! neither read nor swap it, and its receipt goes back sealed for the next tick to log.

use super::seal_to;
use crate::codec::{b64, from_b64, parse, to_borsh};
use crate::host;
use crate::http::{self, deadline_in, encode_component, passed, sleep_ms, Method};
use crate::records::{domain, HintBlob};
use crate::state;
use crate::vault::{self, Purpose};
use crate::voice::{self, ChatSignature, Fact};
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::digest::{sha256, voice_sig_digest};
use tail_protocol::{MatchId, SignedVoiceLine, VoiceLine};

const AUTHORITY: &str = "cloud-api.near.ai";
const DEFAULT_MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
/// TECHNICAL.md 4.7: over 3 s, use the template.
const COMPLETION_BUDGET_MS: u64 = 3_000;
/// The signature lookup can 404 until the right TEE node is found (F2); it does not hold up
/// the line itself, only the receipt.
const SIGNATURE_BUDGET_MS: u64 = 10_000;
const SIGNATURE_RETRY_MS: u64 = 500;

/// One entry of a tick's `hints` list, plus any state blob of the match (for the asker's box
/// key and the referee's own; voice changes no state, so any blob of the match will do).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    state: String,
    /// `match_id ‖ sealed HintBlob`, as `tick` returned it.
    blob: String,
}

struct Opened {
    hint: HintBlob,
    asker_pk: [u8; 32],
    box_sk: [u8; 32],
    /// `voice::request_nonce` for this hint.
    nonce: String,
}

/// The hint, the asker's box key and the request nonce, from the blob and the state.
fn open_hint(i: &Input) -> Result<Opened, String> {
    let blob = from_b64("blob", &i.blob)?;
    if blob.len() < 16 {
        return Err("blob is too short to name a match".into());
    }
    let (id, sealed) = blob.split_at(16);
    let match_id: MatchId = id.try_into().expect("16 bytes");
    let st = state::open(&from_b64("state", &i.state)?, domain::STATE, &match_id)?;
    let plain = vault::open(&st.box_sk, Purpose::Hint, &match_id, &[], sealed)?;
    let hint: HintBlob = borsh::from_slice(&plain).map_err(|e| format!("hint blob: {e}"))?;
    if hint.match_id != match_id {
        return Err("hint blob names another match".into());
    }
    let asker = *st
        .box_pks
        .get(usize::from(hint.player))
        .ok_or("hint blob names an unknown player")?;
    let nonce = voice::request_nonce(st.core.log_key(), hint.hint_id);
    Ok(Opened {
        hint,
        asker_pk: asker,
        box_sk: st.box_sk,
        nonce,
    })
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
    let Opened {
        hint,
        asker_pk,
        box_sk,
        nonce,
    } = open_hint(&i)?;
    let fact = Fact::new(hint.hint, hint.value)?;
    let question = hint.question.as_deref().map(voice::clean_question).transpose()?;
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

    let request = voice::request_body(&model, fact, hint.recent, question.as_deref(), &nonce);
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
        hint_id: hint.hint_id,
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

    let line = VoiceLine {
        match_id: hint.match_id,
        player: hint.player,
        hint_id: hint.hint_id,
        text,
    };
    let sig = host::sign_digest(&voice_sig_digest(&line))?;
    let sealed = seal_to(
        &asker_pk,
        &to_borsh(&SignedVoiceLine { line, sig }),
        tail_protocol::domain::VOICE,
    )?;
    // Voice changes no state and appends nothing: the receipt joins the log in the tick (or
    // `end`) that takes it, salted for the index it lands at, and shows up in that call's own
    // `leaves` and `log_sealed`.
    let receipt = vault::seal(
        &box_sk,
        Purpose::Receipt,
        &hint.match_id,
        &[],
        &to_borsh(&receipt),
    );

    // Nothing here names the fact or the words. `signed_text` is what NEAR AI signed
    // (`model:sha256(request):sha256(response)`); the replay needs it to check the signature
    // that the receipt carries into the log. The request's nonce keeps its hash unguessable.
    // `hint_id` is public already: the Hint verdict on chain carries it.
    Ok(json!({
        "player": hint.player,
        "hint_id": hint.hint_id,
        "sealed": b64(&sealed),
        "signed_text": signature.as_ref().map(|s| s.text.clone()),
        "receipt": b64(&receipt),
        "source": if chat.is_some() { "model" } else { "template" },
        "model": model,
        "latency_ms": latency_ms,
        "fallback_reason": fallback_reason,
        "signature_error": signature_error,
    }))
}
