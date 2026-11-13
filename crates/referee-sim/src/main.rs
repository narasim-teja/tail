//! `referee-sim <scenario.json>…` runs scripted matches and checks their `expect` blocks.
//! `referee-sim bench [players] [minutes] [radius_m] [hunt|wander|clump]` runs the performance match.

use referee_sim::scenario::BotMode;
use referee_sim::{check, load, random_walk, run, stats};
use std::process::ExitCode;

fn bench(args: &[String]) -> Result<(), String> {
    let num = |i: usize, d: u64| {
        args.get(i)
            .map_or(Ok(d), |s| s.parse::<u64>().map_err(|e| e.to_string()))
    };
    let (n, minutes, radius) = (num(0, 12)?, num(1, 60)?, num(2, 150)?);
    let bots = match args.get(3).map_or("wander", String::as_str) {
        "hunt" => BotMode::Hunt,
        "wander" => BotMode::Wander,
        "clump" => BotMode::Clump,
        other => return Err(format!("unknown bot mode {other} (hunt, wander, clump)")),
    };
    let sc = random_walk(
        usize::try_from(n).map_err(|e| e.to_string())?,
        minutes,
        u32::try_from(radius).map_err(|e| e.to_string())?,
        bots,
    );
    let r = run(&sc)?;
    let s = stats(&r);
    println!("{}: {s:#?}", sc.name);
    let alive = r
        .huds
        .iter()
        .rev()
        .take(r.names.len())
        .filter(|(_, _, h)| h.status != 1)
        .count();
    println!("survivors: {alive}");
    Ok(())
}

/// Every tick's HUDs, verdicts, rejections and refusals, for writing a scenario's `expect`.
fn print_trace(r: &referee_sim::Report) {
    for (t, p, h) in &r.huds {
        println!(
            "{t:>5}s {:<8} lock {} heat {} head {:>9} status {} target {:<8} leak {} hint {:?}",
            r.name(*p),
            h.lock,
            h.heat,
            h.head,
            h.status,
            h.target,
            h.leak.is_some(),
            h.hint_fact.map(|f| (f.hint, f.value))
        );
    }
    for (t, tick, v) in &r.verdicts {
        println!(
            "{t:>5}s tick {tick} verdict {} {}",
            v.seq,
            r.verdict_text(&v.body)
        );
    }
    for (t, x) in &r.rejections {
        println!(
            "{t:>5}s rejected {} seq {} {:?} (code {})",
            r.name(x.player),
            x.seq,
            x.reason,
            x.reason.code()
        );
    }
    for e in &r.log {
        if let tail_protocol::LogEntry::Evidence {
            hunter,
            target,
            strike_seq,
            strike_epoch,
            epochs,
        } = e
        {
            println!(
                "evidence {} → {} strike seq {strike_seq} epoch {strike_epoch} contact epochs {epochs:?}",
                r.name(*hunter),
                r.name(*target)
            );
        }
    }
    for (t, x) in &r.refusals {
        println!(
            "{t:>5}s refused {} {:?} {:?}",
            r.name(x.player),
            x.action,
            x.reason
        );
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("bench") {
        return match bench(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("bench: {e}");
                ExitCode::FAILURE
            }
        };
    }
    if args.is_empty() {
        eprintln!("usage: referee-sim [--trace] <scenario.json>… | referee-sim bench [players] [minutes] [radius_m] [hunt|wander|clump]");
        return ExitCode::FAILURE;
    }
    let trace = args.iter().any(|a| a == "--trace");
    let mut ok = true;
    for path in args.iter().filter(|a| *a != "--trace") {
        let result = load(std::path::Path::new(path)).and_then(|sc| run(&sc).map(|r| (sc, r)));
        match result {
            Ok((sc, r)) => {
                if trace {
                    print_trace(&r);
                }
                let bad = check(&sc.expect, &r);
                if bad.is_empty() {
                    println!("ok    {}  {:?}", sc.name, r.verdict_texts(false));
                } else {
                    ok = false;
                    println!("FAIL  {}", sc.name);
                    for b in bad {
                        println!("      {b}");
                    }
                }
            }
            Err(e) => {
                ok = false;
                println!("FAIL  {path}: {e}");
            }
        }
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
