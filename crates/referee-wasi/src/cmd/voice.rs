//! `voice`: one Handler line for a hint, from NEAR AI Cloud with its TEE signature, or a
//! template sentence when the model misses the 3 s budget.
//!
//! The hint comes as the sealed blob `tick` returned, so the fact is the referee's own and the
//! relay never learns it. The line goes back signed and sealed to the asker, so the relay can
//! neither read nor swap it, and its receipt goes back sealed for the next tick to log.

use super::{seal_receipt, seal_to};
use crate::codec::{b64, from_b64, parse};
use crate::host;
use crate::http::{self, deadline_in, encode_component, passed, sleep_ms, Method};
use crate::records::{domain, HintBlob};
use crate::state;
use crate::vault::{self, Purpose};
use crate::voice::{self, ChatSignature, Fact};
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::digest::{sha256, voice_sig_digest};
use tail_protocol::{MatchId, SignedVoiceLine, VoiceLine, VOICE_TEXT_MAX};

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
    let hint = HintBlob::decode(&plain)?;
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

/// The line the player gets: the model's, or the template when the model gave none or one too
/// long to seal at the one size every message to a phone has. A long line is not an error: the
/// hint is paid for either way, so the player still hears its fact.
fn spoken(fact: Fact, completion: Option<Completion>) -> (String, Option<Completion>) {
    match completion.filter(|c| c.text.len() <= VOICE_TEXT_MAX) {
        Some(c) => (c.text.clone(), Some(c)),
        None => (fact.template(), None),
    }
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
    // model is asked, so no key is needed.
    let key: Option<String> = match http::OFFLINE {
        Some(_) => None,
        None => {
            Some(host::author_secret("NEARAI_API_KEY").ok_or("the NEARAI_API_KEY author secret is not set")?)
        }
    };
    let model = host::author_secret("NEARAI_MODEL").unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    voice::check_model(&model)?;

    let request = voice::request_body(&model, fact, hint.recent, question.as_deref(), &nonce);
    // Whether the model answered, and why not, stays here: the relay learns only what
    // `signed_text` tells it, and the logged receipt (empty chat id or signature) tells the rest
    // after End.
    let (text, chat) = spoken(fact, key.as_deref().and_then(|key| complete(key, &request).ok()));
    let signature = match (key.as_deref(), &chat) {
        (Some(key), Some(c)) => fetch_signature(key, &model, c).ok(),
        _ => None,
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
    let sealed = seal_to(&asker_pk, &SignedVoiceLine { line, sig })?;
    // Voice changes no state and appends nothing: the receipt joins the log in the tick (or
    // `end`) that takes it, salted for the index it lands at, and shows up in that call's own
    // `leaves` and `log_sealed`. It is bound to this hint and to this sealed line, so it cannot
    // stand for another line of the same hint.
    let receipt = seal_receipt(&box_sk, &hint.match_id, &sealed, &receipt);

    // Nothing here names the fact or the words: `sealed` is one fixed size whatever the line.
    // `signed_text` is what NEAR AI signed (`model:sha256(request):sha256(response)`); the
    // replay needs it to check the signature that the receipt carries into the log. The
    // request's nonce keeps its hash unguessable. `hint_id` is public already: the Hint verdict
    // on chain carries it.
    Ok(json!({
        "player": hint.player,
        "hint_id": hint.hint_id,
        "sealed": b64(&sealed),
        "signed_text": signature.as_ref().map(|s| s.text.clone()),
        "receipt": b64(&receipt),
    }))
}

#[cfg(test)]
mod tests {
    use super::{spoken, Completion, Fact};
    use tail_protocol::VOICE_TEXT_MAX;

    fn completion(text: String) -> Completion {
        Completion {
            chat_id: "chatcmpl-1".into(),
            text,
            request_sha: "aa".into(),
            response_sha: "bb".into(),
        }
    }

    #[test]
    fn an_over_long_model_line_falls_back_to_the_template() {
        let fact = Fact::Near(true);
        let fits = "a".repeat(VOICE_TEXT_MAX);
        let (text, chat) = spoken(fact, Some(completion(fits.clone())));
        assert_eq!(text, fits);
        assert_eq!(chat.map(|c| c.chat_id).as_deref(), Some("chatcmpl-1"));
        // One byte over (a multi-byte character counts by its bytes, as sealing does).
        for long in ["a".repeat(VOICE_TEXT_MAX + 1), "é".repeat(VOICE_TEXT_MAX / 2 + 1)] {
            let (text, chat) = spoken(fact, Some(completion(long)));
            assert_eq!(text, fact.template());
            assert!(chat.is_none(), "no receipt names a line the player did not get");
        }
        let (text, chat) = spoken(fact, None);
        assert_eq!(text, fact.template());
        assert!(chat.is_none());
    }
}
