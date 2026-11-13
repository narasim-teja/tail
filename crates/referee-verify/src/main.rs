//! `tail-verify <bundle.json | -> [--app-id ID] [--strict]`
//!
//! Exit status: 0 the re-execution reproduced every verdict and log entry; 1 a check failed or
//! the re-execution diverged (the report names the first tick and entry); 2 the file is not a
//! v2 replay bundle; 3 with `--strict`, it passed but had to take something from the log.

use referee_verify::{verify_json, Options, Stage};
use std::io::Read as _;
use std::process::ExitCode;

const USAGE: &str = "usage: tail-verify <bundle.json | -> [--app-id ID] [--strict]";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut path = None;
    let mut strict = false;
    let mut opts = Options::default();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--strict" => strict = true,
            "--app-id" => match args.next() {
                Some(id) => opts.app_id = id,
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
    for n in &o.notes {
        println!("checked   {n}");
    }
    for t in &o.trusted {
        println!("trusted   {t}");
    }
    match &o.failure {
        None if o.trusted.is_empty() => {
            println!("PASS      every verdict and log entry follows from the released inputs");
            ExitCode::SUCCESS
        }
        None => {
            println!("PASS      every verdict and log entry follows from the released inputs and the trusted items above");
            if strict {
                ExitCode::from(3)
            } else {
                ExitCode::SUCCESS
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

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}
