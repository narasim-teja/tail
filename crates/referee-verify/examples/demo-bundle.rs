//! Prints the replay bundle of a scripted match (the tests' match) as the relay would serve it.
//!
//! `demo-bundle [--relay-today] [--forge-tag]`: `--relay-today` leaves out the device keys,
//! the assertions and the refused batches, as the relay serves bundles now; `--forge-tag`
//! swaps the first Tag's hunter and target and signs it with the referee key.

#[path = "../tests/driver/mod.rs"]
mod driver;

use tail_protocol::Verdict;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut p = driver::play();
    if args.iter().any(|a| a == "--forge-tag") {
        if let Some(v) = p
            .verdicts
            .iter_mut()
            .find(|v| matches!(v.body, Verdict::Tag { .. }))
        {
            if let Verdict::Tag { hunter, target } = v.body {
                v.body = Verdict::Tag {
                    hunter: target,
                    target: hunter,
                };
            }
        }
    }
    let extras = if args.iter().any(|a| a == "--relay-today") {
        driver::RELAY_TODAY
    } else {
        driver::FULL
    };
    let b = driver::bundle(&p, extras);
    println!(
        "{}",
        serde_json::to_string_pretty(&b).expect("a bundle serialises")
    );
}
