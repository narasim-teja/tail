//! `devices`: which of these accounts the referee holds a device for, as `start` would read it.
//!
//! The relay keeps each device's enrolment receipt and takes it as proof that the referee holds
//! the device. That belief can go stale (a record in a layout `start` no longer reads, storage
//! of a referee that was reset), and `start` comes after the lobby is locked on chain, so a
//! refusal there costs the whole lobby. Asked before the lock, this answers for each account
//! with the receipt body of the record `start` would load, or null when `start` would refuse
//! it. Read-only.

use crate::codec::{b64, parse, to_borsh};
use crate::records::{device_record_key, DeviceRecord};
use crate::{account, host};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    accounts: Vec<String>,
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: Input = parse(input)?;
    // A lobby's players at most: each one is a storage read.
    if i.accounts.len() > referee_core::MAX_PLAYERS {
        return Err(format!("at most {} accounts", referee_core::MAX_PLAYERS));
    }
    for a in &i.accounts {
        account::validate(a)?;
    }
    let devices = i
        .accounts
        .iter()
        .map(|a| {
            let held = match host::storage_get(&device_record_key(a))? {
                None => json!({ "account_id": a, "receipt": null }),
                // The same decoder `start` uses, so "held" means `start` can read it.
                Some(bytes) => match DeviceRecord::decode(&bytes) {
                    Ok(r) => json!({ "account_id": a, "receipt": b64(&to_borsh(&r.device)) }),
                    Err(e) => json!({ "account_id": a, "receipt": null, "unreadable": e }),
                },
            };
            Ok(held)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({ "devices": devices }))
}
