//! TAIL referee on OutLayer: one project, one command per call (`input.cmd`), JSON in and out,
//! binary fields base64. See README.md for every command's shape. Built natively, the same
//! code is the local test referee: one process per command, keys on disk (`host`).
//!
//! The manifest (`manifest.json`) is not embedded with `#[link_section]`: that attribute is
//! unsafe code and the lint table forbids it. `scripts/build.ts` appends it to the component as
//! an `outlayer.manifest` custom section instead, so the deployed wasm hash still covers it.

mod account;
mod cmd;
mod codec;
mod host;
mod http;
mod records;
mod state;
mod voice;

use serde_json::{json, Value};

fn main() {
    let out = match run() {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    // Writing stdout is the only way to answer; if it fails there is nobody left to tell.
    host::output_json(&out).expect("stdout is writable");
}

fn run() -> Result<Value, String> {
    // Every command is the relay's, and the relay is the project owner (see host::require_owner).
    host::require_owner()?;
    let mut input: Value = host::input_json()
        .map_err(|e| format!("input is not JSON: {e}"))?
        .ok_or("no input")?;
    // `cmd` picks the command; the rest is that command's input, whose shape it checks.
    let Some(Value::String(name)) = input.as_object_mut().and_then(|o| o.remove("cmd")) else {
        return Err("input.cmd is missing".into());
    };
    cmd::dispatch(&name, input)
}
