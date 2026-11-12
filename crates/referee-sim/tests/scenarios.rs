//! The scripted matches of TECHNICAL.md 11. Each JSON trace in `scenarios/` carries its own
//! `expect` block; every "this does not happen" trace has a twin where the deciding condition
//! changes and it does happen. The simulator itself checks, after every tick, that the sum of
//! heads is unchanged, verdict seqs are contiguous, the state survives its borsh round trip and
//! every checkpoint root is the RFC 6962 root of the log so far.

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
fn in_a_duel_the_earlier_strike_in_the_same_tick_wins() {
    passes("duel-alice-earlier");
}

#[test]
fn in_a_duel_moving_the_other_strike_earlier_flips_the_winner() {
    passes("duel-bob-earlier");
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

#[test]
fn simultaneous_duel_strikes_are_decided_by_the_vrf_coin_and_each_side_can_win() {
    let mut winners = std::collections::BTreeSet::new();
    for k in 0..12 {
        let mut sc = scenario("duel-same-instant");
        sc.name = format!("duel-same-instant-{k}");
        let r = run(&sc).unwrap();
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
        winners.insert(hunter);
    }
    assert_eq!(
        winners.len(),
        2,
        "the coin, not the player index, picks the winner"
    );
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
fn twelve_hunting_players_tag_each_other_without_losing_money() {
    let r = run(&random_walk(12, 10, 150, BotMode::Hunt)).unwrap();
    let s = stats(&r);
    assert!(s.tags > 0, "{s:?}");
    assert_eq!(r.final_heads.iter().sum::<u128>(), 12 * 1_000_000);
}
