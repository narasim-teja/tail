//! The scripted matches of TECHNICAL.md 11. Each JSON trace in `scenarios/` carries its own
//! `expect` block; every "this does not happen" trace has a twin where the deciding condition
//! changes and it does happen. The simulator itself checks, after every call, that the sum of
//! heads is unchanged, the state survives its borsh round trip, verdicts are contiguous and
//! chained by `prev`, every checkpoint root is the RFC 6962 root of the log so far with a
//! consistency proof that verifies and equals the full-log proof, every tick's log starts with
//! its `Tick`, every refused batch is logged as `Rejected`, and every Tag follows an `Evidence`
//! entry that justifies its lock (`referee_sim::run`).

use referee_core::COIN_DOMAIN;
use referee_sim::scenario::{BotMode, Scenario};
use referee_sim::{check, load, random_walk, run, stats, Report};
use tail_protocol::digest::sha256;
use tail_protocol::{LogEntry, Verdict};

fn scenario(name: &str) -> Scenario {
    load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("scenarios/{name}.json"))).unwrap()
}

fn passes(name: &str) -> Report {
    let sc = scenario(name);
    let r = run(&sc).unwrap();
    let bad = check(&sc.expect, &r);
    assert!(bad.is_empty(), "{name}:\n  {}", bad.join("\n  "));
    r
}

#[test]
fn a_hunter_who_holds_contact_until_the_lock_fills_tags_the_target_and_inherits_its_target() {
    passes("clean-tag");
}

#[test]
fn a_target_who_leaves_before_the_lock_fills_escapes_the_strike() {
    passes("target-escapes");
}

#[test]
fn a_token_replayed_from_an_old_epoch_creates_no_contact() {
    passes("replayed-token");
}

#[test]
fn the_same_relay_with_live_tokens_does_create_contact_which_is_the_documented_wormhole_limit() {
    passes("relayed-live-token");
}

#[test]
fn a_one_sided_sighting_is_not_contact() {
    passes("one-sided");
}

#[test]
fn the_same_sighting_heard_both_ways_is_contact() {
    passes("mutual");
}

#[test]
fn a_teleport_rejects_batches_until_the_move_is_plausible_and_walking_back_is_fine() {
    passes("teleport");
}

#[test]
fn simulated_or_accessory_locations_reject_the_batch_and_the_gap_leaks_to_the_hunter() {
    passes("simulated-location");
}

#[test]
fn going_dark_leaks_a_grid_cell_at_45_s_and_forfeits_after_180_s_in_total() {
    passes("dark-leak-forfeit");
}

#[test]
fn brief_dark_spells_never_leak_and_never_forfeit() {
    passes("dark-brief");
}

#[test]
fn a_vehicle_freezes_contact_for_two_minutes_after_which_the_lock_fills_again() {
    passes("vehicle-freeze");
}

#[test]
fn a_safehouse_blocks_the_lock_until_the_target_leaves_it() {
    passes("safehouse");
}

#[test]
fn leaving_the_zone_counts_as_dark_while_staying_near_the_edge_does_not() {
    passes("out-of-zone");
}

#[test]
fn hints_move_money_from_asker_to_target_and_respect_cooldown_kind_text_and_head() {
    let r = passes("hint-economics");
    // Every hint got its voice receipt into the log exactly once.
    let receipts: Vec<u32> = r
        .log
        .iter()
        .filter_map(|e| match e {
            LogEntry::HintReceipt { hint_id, .. } => Some(*hint_id),
            _ => None,
        })
        .collect();
    let issued: Vec<u32> = r.hints.iter().map(|(_, h)| h.hint_id).collect();
    assert_eq!(receipts, issued);
    assert_eq!(issued.len(), 24);
}

#[test]
fn in_a_duel_a_strike_in_an_earlier_tick_wins() {
    passes("duel-earlier-tick");
}

fn coin(vrf_signature: &[u8], tick_no: u32, player: u16) -> [u8; 32] {
    let vrf_out = sha256(&[vrf_signature]);
    sha256(&[
        COIN_DOMAIN,
        &vrf_out,
        &tick_no.to_le_bytes(),
        &player.to_le_bytes(),
    ])
}

/// The one tag of a duel, checked against the coin: the lower coin of its tick strikes first.
fn coin_winner(r: &Report) -> u16 {
    let tags: Vec<(u32, u16)> = r
        .verdicts
        .iter()
        .filter_map(|(_, tick, v)| match v.body {
            Verdict::Tag { hunter, .. } => Some((*tick, hunter)),
            _ => None,
        })
        .collect();
    assert_eq!(tags.len(), 1, "exactly one strike lands");
    let (tick, hunter) = tags[0];
    let want = u16::from(coin(&r.vrf_signature, tick, 1) < coin(&r.vrf_signature, tick, 0));
    assert_eq!(hunter, want, "the lower coin strikes first");
    hunter
}

#[test]
fn in_a_duel_an_earlier_device_time_in_the_same_tick_does_not_win_the_coin_does() {
    let r = passes("duel-alice-earlier");
    assert_eq!(r.name(coin_winner(&r)), "bob", "alice's batch was dated earlier");
    let r = passes("duel-bob-earlier");
    coin_winner(&r);
}

/// Runs a duel trace under twelve match names and returns who won each.
fn duel_winners(trace: &str) -> std::collections::BTreeSet<u16> {
    (0..12)
        .map(|k| {
            let mut sc = scenario(trace);
            sc.name = format!("{trace}-{k}");
            coin_winner(&run(&sc).unwrap())
        })
        .collect()
}

#[test]
fn simultaneous_duel_strikes_are_decided_by_the_vrf_coin_and_each_side_can_win() {
    assert_eq!(
        duel_winners("duel-same-instant").len(),
        2,
        "the coin, not the player index, picks the winner"
    );
}

#[test]
fn a_clock_set_back_does_not_win_a_duel() {
    assert_eq!(
        duel_winners("duel-clock-behind").len(),
        2,
        "alice's clock runs 15 s behind, and still bob wins some"
    );
}

#[test]
fn a_hunter_who_inherits_a_target_starts_its_lock_from_scratch() {
    passes("inherited-target");
}

#[test]
fn an_indoor_fix_keeps_a_player_present_while_approximate_location_goes_dark() {
    passes("indoor-accuracy");
}

#[test]
fn moving_the_clock_cannot_skip_the_hint_cooldown_or_send_batches_back_in_time() {
    passes("clock-jumps");
}

#[test]
fn a_sighting_listed_twice_in_a_batch_counts_once() {
    passes("duplicate-sightings");
}

#[test]
fn the_honest_twin_hearing_two_samples_per_epoch_listed_once_does_tag() {
    use referee_sim::scenario::Event;
    let mut sc = scenario("duplicate-sightings");
    sc.name = "duplicate-sightings-honest".into();
    sc.events.retain(|e| !matches!(e, Event::Copies { .. }));
    for r in sc.radio.iter_mut().filter(|r| r.a == "alice") {
        r.to = r.from + 2;
    }
    let r = run(&sc).unwrap();
    assert_eq!(r.verdict_texts(false), ["Start", "Tag alice bob", "End"]);
}

#[test]
fn a_strike_short_only_of_the_targets_late_data_waits_one_tick_and_lands() {
    passes("strike-waits-for-target");
}

#[test]
fn a_strike_waits_only_once_for_a_target_who_stays_offline() {
    passes("strike-waits-once");
}

#[test]
fn a_reconnect_backlog_is_accepted_and_its_contacts_count() {
    passes("backlog-reconnect");
}

#[test]
fn twelve_wandering_players_keep_the_state_small_and_all_invariants_for_ten_minutes() {
    let r = run(&random_walk(12, 10, 150, BotMode::Wander)).unwrap();
    let s = stats(&r);
    assert_eq!(s.ticks, 60);
    assert!(s.contacts > 0 && s.hints > 0, "{s:?}");
    assert!(s.state_bytes_max < 32 * 1024, "{s:?}");
    assert_eq!(r.final_heads.iter().sum::<u128>(), 12 * 1_000_000);
}

#[test]
fn a_refused_batch_is_logged_as_rejected_with_its_code() {
    let r = passes("teleport");
    let codes: Vec<u8> = r
        .log
        .iter()
        .filter_map(|e| match e {
            LogEntry::Rejected { code, .. } => Some(*code),
            _ => None,
        })
        .collect();
    assert_eq!(codes.len(), r.rejections.len());
    assert!(!codes.is_empty() && codes.iter().all(|c| *c == tail_protocol::reject_code::TELEPORT));
}

#[test]
fn a_whole_match_anchors_a_root_every_minute_each_proved_consistent_with_the_last() {
    // `run` fails unless every proof verifies and equals the full-log one; here, how many.
    let r = run(&random_walk(6, 10, 150, BotMode::Hunt)).unwrap();
    let anchored = r
        .verdicts
        .iter()
        .filter(|(_, _, v)| matches!(v.body, Verdict::Checkpoint { .. } | Verdict::End { .. }))
        .count();
    assert!(anchored >= 2, "{anchored}");
    let ticks = r
        .log
        .iter()
        .filter(|e| matches!(e, LogEntry::Tick { .. }))
        .count();
    assert_eq!(ticks, r.tick_us.len(), "one Tick entry per tick");
    let enrolled = r
        .log
        .iter()
        .take_while(|e| matches!(e, LogEntry::Enrolled { .. }))
        .count();
    assert_eq!(enrolled, 6);
}

#[test]
fn twelve_hunting_players_tag_each_other_without_losing_money() {
    let r = run(&random_walk(12, 10, 150, BotMode::Hunt)).unwrap();
    let s = stats(&r);
    assert!(s.tags > 0, "{s:?}");
    assert_eq!(r.final_heads.iter().sum::<u128>(), 12 * 1_000_000);
}
