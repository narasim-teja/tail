//! `pubkeys`: the keys a phone, the relay and the contract pin, and the App ID the referee
//! checks attestations and assertions against.

use super::APP_ID;
use crate::codec::{b64, parse};
use crate::host;
use crate::records::box_statement_digest;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {}

pub fn run(input: Value) -> Result<Value, String> {
    let _: Input = parse(input)?;
    let referee_pk = host::referee_pk()?;
    let box_pk = tail_protocol::seal::public_key(&host::box_sk()?);
    // Phones seal batches to the box key; this signature lets them check it is the referee's.
    let box_sig = host::sign_digest(&box_statement_digest(&box_pk))?;
    Ok(json!({
        "referee_pk": b64(&referee_pk),
        "referee_pk_hex": hex::encode(referee_pk),
        "referee_box_pk": b64(&box_pk),
        "box_pk_sig": b64(&box_sig),
        "vrf_pk": host::vrf_pk()?,
        // Pinned in the code; the relay writes its own into the replay bundle and checks the two
        // agree before serving.
        "app_id": APP_ID,
    }))
}
