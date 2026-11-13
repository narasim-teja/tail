//! `tail-verify <bundle.json | -> [--referee-pk HEX] [--vrf-pk HEX] [--app-id ID] [--allow-trusted]`
//!
//! Exit status: 0 the re-execution reproduced every verdict and log entry and nothing was taken
//! from the log; 1 a check failed, a pinned key differs, or the re-execution diverged (the report
//! names the first tick and entry); 2 the file is not a v2 replay bundle, or the arguments are
//! wrong; 3 it reproduced everything but had to take something from the log, unless
//! `--allow-trusted` accepts that. `--strict` is the default and is accepted for older callers.

use referee_verify::{verify_json, Options, Stage};
use std::io::Read as _;
use std::process::ExitCode;

const USAGE: &str =
    "usage: tail-verify <bundle.json | -> [--referee-pk HEX] [--vrf-pk HEX] [--app-id ID] [--allow-trusted]";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut path = None;
    let mut allow_trusted = false;
    let mut opts = Options::default();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--strict" => {}
            "--allow-trusted" => allow_trusted = true,
            "--app-id" => match args.next() {
                Some(id) => opts.app_id = id,
                None => return usage(),
            },
            "--referee-pk" => match args.next().as_deref().and_then(key) {
                Some(k) => opts.referee_pk = Some(k),
                None => return usage(),
            },
            "--vrf-pk" => match args.next().as_deref().and_then(key) {
                Some(k) => opts.vrf_pk = Some(k),
                None => return usage(),
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            _ if path.is_none() => path = Some(a),
            _ => return usage(),
        }
    }
    let Some(path) = path else {
        return usage();
    };
    let mut json = String::new();
    let read = if path == "-" {
        std::io::stdin().read_to_string(&mut json).map(|_| ())
    } else {
        std::fs::read_to_string(&path).map(|s| json = s)
    };
    if let Err(e) = read {
        eprintln!("tail-verify: {path}: {e}");
        return ExitCode::from(2);
    }

    let o = verify_json(&json, &opts);
    for l in &o.lines {
        println!("{l}");
    }
    println!();
    for i in &o.inputs {
        println!("input     {i}");
    }
    for w in &o.warnings {
        println!("warning   {w}");
    }
    for n in &o.notes {
        println!("checked   {n}");
    }
    for t in &o.trusted {
        println!("trusted   {t}");
    }
    let keys = match (opts.referee_pk.is_some(), opts.vrf_pk.is_some()) {
        (true, true) => "under the pinned referee and VRF keys",
        (false, false) => "under the bundle's own referee and VRF keys, not pinned",
        (true, false) => "under the pinned referee key and the bundle's own VRF key",
        (false, true) => "under the bundle's own referee key and the pinned VRF key",
    };
    match &o.failure {
        None if o.trusted.is_empty() => {
            println!("PASS      every verdict and log entry follows from the inputs above, {keys}");
            ExitCode::SUCCESS
        }
        None => {
            let n = o.trusted.len();
            println!(
                "PASS      every verdict and log entry follows from the inputs above and the {n} trusted items, {keys}"
            );
            if allow_trusted {
                ExitCode::SUCCESS
            } else {
                println!("exit 3    {n} items were trusted, not re-executed; --allow-trusted accepts them");
                ExitCode::from(3)
            }
        }
        Some(f) => {
            let at = match f.stage {
                Stage::Tick(n) => format!("tick {n}"),
                s => format!("{s:?}").to_lowercase(),
            };
            println!("FAIL      {at}: {}", f.what);
            if f.stage == Stage::Bundle {
                ExitCode::from(2)
            } else {
                ExitCode::FAILURE
            }
        }
    }
}

/// A 32-byte ed25519 key in hex.
fn key(s: &str) -> Option<[u8; 32]> {
    hex::decode(s).ok()?.try_into().ok()
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}
