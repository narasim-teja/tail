//! Engine-level rules that do not need a whole simulated match: init, the Start verdict, batch
//! authenticity, tick ordering, finish, receipts, the sealed state and what an out player's HUD
//! says. Each rejection test has a
//! twin where the one broken input is fixed and the batch goes through.

use p256::ecdsa::SigningKey;
use referee_core::{
    finish, init, tick, Circle, Device, FinishError, HintReceipt, InitError, MatchConfig, Phase, Reject,
    State, TickError, TickInput, TickOutput,
};
use tail_protocol::beacon::{beacon_token, derive_player_key, derive_tag_key, epoch_at};
use tail_protocol::digest::{batch_client_data_hash, batch_hash, sha256, verdict_digest};
use tail_protocol::{
    ring, target_status, Action, Batch, BatchEnvelope, Fix, Hash, Hud, LogEntry, Sighting, Verdict, EPOCH_MS,
};

const START: u64 = 1_800_000_000_000;
const APP: &str = "TEAM.dev.tail.test";
const K_M: [u8; 32] = [7; 32];
const VRF: [u8; 64] = [9; 64];
const MATCH: [u8; 16] = [1; 16];

fn cfg() -> MatchConfig {
    MatchConfig {
        match_id: MATCH,
        app_id: APP.into(),
        stake: 1_000_000,
        duration_ms: 600_000,
        zone: Circle {
            lat_e7: 423_550_000,
            lon_e7: -710_660_000,
            radius_m: 1_000,
        },
        safehouses: Vec::new(),
    }
}

struct Phone {
    player: u16,
    sk: SigningKey,
    seq: u32,
    prev: Hash,
    counter: u32,
}

impl Phone {
    fn new(player: u16, name: &str) -> Self {
        let mut seed = [0u8; 32];
        seed[..name.len()].copy_from_slice(name.as_bytes());
        seed[31] = 1;
        Self {
            player,
            sk: SigningKey::from_slice(&seed).unwrap(),
            seq: 0,
            prev: [0; 32],
            counter: 0,
        }
    }

    fn device(&self, name: &str) -> Device {
        Device {
            account_id: name.into(),
            key: appattest::public_key_bytes(self.sk.verifying_key()),
            counter: 0,
            attested: true,
        }
    }

    fn unsigned(&self, t_ms: u64, fixes: Vec<Fix>, actions: Vec<Action>) -> Batch {
        Batch {
            match_id: MATCH,
            player: self.player,
            seq: self.seq,
            prev: self.prev,
            t_ms,
            fixes,
            sightings: Vec::new(),
            actions,
        }
    }

    fn seal(&mut self, batch: Batch, counter: u32) -> BatchEnvelope {
        let assertion = appattest::sign_assertion(&self.sk, &batch_client_data_hash(&batch), APP, counter);
        self.counter = counter;
        self.seq = batch.seq + 1;
        self.prev = batch_hash(&batch);
        BatchEnvelope { batch, assertion }
    }

    fn next(&mut self, t_ms: u64, fixes: Vec<Fix>, actions: Vec<Action>) -> BatchEnvelope {
        let b = self.unsigned(t_ms, fixes, actions);
        let c = self.counter + 1;
        self.seal(b, c)
    }
}

fn fix(t_ms: u64, north_m: i32) -> Fix {
    Fix {
        t_ms,
        lat_e7: 423_550_000 + north_m * 90,
        lon_e7: -710_660_000,
        acc_m: 5,
        speed_cmps: 0,
        flags: 0,
    }
}

fn three() -> (State, Vec<Phone>) {
    let phones = vec![Phone::new(0, "a"), Phone::new(1, "b"), Phone::new(2, "c")];
    let devices = ["a", "b", "c"]
        .iter()
        .zip(&phones)
        .map(|(n, p)| p.device(n))
        .collect();
    let started = init(cfg(), devices, &K_M, &VRF, START, [0; 16]).unwrap();
    (started.state, phones)
}

fn input(tick_no: u32, now_ms: u64, batches: Vec<BatchEnvelope>) -> TickInput {
    TickInput {
        tick_no,
        now_ms,
        call_id: [tick_no as u8; 16],
        batches,
        receipts: Vec::new(),
    }
}

fn reasons(out: &TickOutput) -> Vec<(u16, Reject)> {
    out.rejected
        .iter()
        .map(|r| (r.player, r.reason.clone()))
        .collect()
}

#[test]
fn init_refuses_duplicate_accounts_bad_keys_and_too_few_players_and_starts_a_valid_match() {
    let a = Phone::new(0, "a");
    let b = Phone::new(1, "b");
    assert_eq!(
        init(cfg(), vec![a.device("a")], &K_M, &VRF, START, [0; 16]).unwrap_err(),
        InitError::PlayerCount(1)
    );
    assert_eq!(
        init(
            cfg(),
            vec![a.device("a"), b.device("a")],
            &K_M,
            &VRF,
            START,
            [0; 16]
        )
        .unwrap_err(),
        InitError::DuplicateAccount("a".into())
    );
    let mut bad = b.device("b");
    bad.key[0] = 0x05;
    assert_eq!(
        init(cfg(), vec![a.device("a"), bad], &K_M, &VRF, START, [0; 16]).unwrap_err(),
        InitError::BadDeviceKey("b".into())
    );
    assert!(init(
        cfg(),
        vec![a.device("a"), b.device("b")],
        &K_M,
        &VRF,
        START,
        [0; 16]
    )
    .is_ok());
}

#[test]
fn the_start_verdict_is_seq_1_and_commits_to_the_players_and_the_ring() {
    let phones = [Phone::new(0, "a"), Phone::new(1, "b"), Phone::new(2, "c")];
    // Devices arrive out of order; indices still follow the sorted account ids.
    let devices = vec![
        phones[2].device("c"),
        phones[0].device("a"),
        phones[1].device("b"),
    ];
    let s = init(cfg(), devices, &K_M, &VRF, START, [5; 16]).unwrap();
    assert_eq!(s.verdicts.len(), 1);
    let v = &s.verdicts[0];
    assert_eq!((v.seq, v.match_id, v.call_id), (1, MATCH, [5; 16]));
    let accounts = ["a", "b", "c"];
    assert_eq!(
        v.body,
        Verdict::Start {
            players_hash: ring::players_hash(&accounts),
            ring_commit: ring::ring_commit(&VRF),
            start_ms: START,
            end_ms: START + 600_000,
        }
    );
    assert_eq!(v.prev, [0; 32], "the first verdict has no predecessor");
    let mut want: Vec<LogEntry> = accounts
        .iter()
        .zip(&phones)
        .enumerate()
        .map(|(i, (a, p))| LogEntry::Enrolled {
            player: i as u16,
            account: (*a).into(),
            key_hash: sha256(&[&p.device(a).key]),
            attested: true,
        })
        .collect();
    want.push(LogEntry::Verdict {
        seq: 1,
        digest: verdict_digest(v),
    });
    assert_eq!(s.log, want, "one Enrolled per player in index order, then Start");
    assert_eq!(s.state.last_verdict_digest(), verdict_digest(v));
    assert_eq!(s.state.next_verdict_seq(), 2);

    let order = ring::build_ring(&accounts, &VRF);
    for (i, (p, keys)) in s.keys.iter().enumerate() {
        assert_eq!(*p as usize, i);
        assert_eq!(keys.player, *p);
        assert_eq!(keys.k_tag, derive_tag_key(&K_M));
        assert_eq!(keys.k_player, derive_player_key(&K_M, *p));
        let k = order.iter().position(|a| a == accounts[i]).unwrap();
        assert_eq!(keys.target, order[(k + 1) % 3], "ring[k] hunts ring[k+1]");
    }
    let views = s.state.players();
    assert_eq!(
        views.iter().map(|p| p.account.as_str()).collect::<Vec<_>>(),
        accounts
    );
    assert_eq!(s.state.total_heads(), 3_000_000);
}

#[test]
fn a_batch_with_a_bad_assertion_is_rejected_without_burning_its_place_in_the_chain() {
    let (st, ph) = three();
    let b = ph[0].unsigned(START + 5_000, vec![fix(START + 5_000, 0)], Vec::new());
    let mut forged = BatchEnvelope {
        batch: b.clone(),
        assertion: appattest::sign_assertion(&ph[1].sk, &batch_client_data_hash(&b), APP, 1),
    };
    let out = tick(st, input(1, START + 10_000, vec![forged.clone()])).unwrap();
    assert_eq!(
        reasons(&out),
        vec![(0, Reject::Assertion(appattest::Step::Signature))]
    );
    forged.assertion = appattest::sign_assertion(&ph[0].sk, &batch_client_data_hash(&b), APP, 1);
    let out = tick(out.state, input(2, START + 20_000, vec![forged])).unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn an_assertion_for_another_app_is_rejected_and_the_right_app_id_passes() {
    let (st, mut ph) = three();
    let b = ph[0].unsigned(START + 5_000, Vec::new(), Vec::new());
    let env = BatchEnvelope {
        batch: b.clone(),
        assertion: appattest::sign_assertion(&ph[0].sk, &batch_client_data_hash(&b), "TEAM.other", 1),
    };
    let out = tick(st, input(1, START + 10_000, vec![env])).unwrap();
    assert_eq!(reasons(&out), vec![(0, Reject::Assertion(appattest::Step::RpId))]);
    let out = tick(out.state, input(2, START + 10_000, vec![ph[0].seal(b, 1)])).unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn a_reused_assertion_counter_is_rejected_and_a_higher_one_passes() {
    let (st, mut ph) = three();
    let first = ph[0].next(START + 5_000, Vec::new(), Vec::new());
    let out = tick(st, input(1, START + 10_000, vec![first])).unwrap();
    let b = ph[0].unsigned(START + 10_000, Vec::new(), Vec::new());
    let replayed_counter = BatchEnvelope {
        batch: b.clone(),
        assertion: appattest::sign_assertion(&ph[0].sk, &batch_client_data_hash(&b), APP, 1),
    };
    let out = tick(out.state, input(2, START + 20_000, vec![replayed_counter])).unwrap();
    assert_eq!(
        reasons(&out),
        vec![(0, Reject::Assertion(appattest::Step::Counter))]
    );
    let out = tick(out.state, input(3, START + 20_000, vec![ph[0].seal(b, 2)])).unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn a_resent_batch_is_rejected_as_a_seq_replay_and_the_next_one_passes() {
    let (st, mut ph) = three();
    let first = ph[0].next(START + 5_000, Vec::new(), Vec::new());
    let out = tick(st, input(1, START + 10_000, vec![first.clone(), first])).unwrap();
    assert_eq!(reasons(&out), vec![(0, Reject::Seq { expected: 1, got: 0 })]);
    let out = tick(
        out.state,
        input(
            2,
            START + 20_000,
            vec![ph[0].next(START + 10_000, Vec::new(), Vec::new())],
        ),
    )
    .unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn a_seq_gap_is_rejected_and_resubmitting_in_order_is_accepted() {
    let (st, mut ph) = three();
    let b0 = ph[0].next(START + 5_000, Vec::new(), Vec::new());
    let b1 = ph[0].next(START + 10_000, Vec::new(), Vec::new());
    let out = tick(st, input(1, START + 10_000, vec![b1.clone()])).unwrap();
    assert_eq!(reasons(&out), vec![(0, Reject::Seq { expected: 0, got: 1 })]);
    // Input order does not matter: the referee sorts by seq.
    let out = tick(out.state, input(2, START + 20_000, vec![b1, b0])).unwrap();
    assert_eq!(out.rejected, vec![]);
    let batches = out
        .log
        .iter()
        .filter(|e| matches!(e, LogEntry::Batch { .. }))
        .count();
    assert_eq!(batches, 2);
}

#[test]
fn a_broken_hash_chain_is_rejected_and_the_true_link_passes() {
    let (st, mut ph) = three();
    let out = tick(
        st,
        input(
            1,
            START + 10_000,
            vec![ph[0].next(START + 5_000, Vec::new(), Vec::new())],
        ),
    )
    .unwrap();
    let good_prev = ph[0].prev;
    ph[0].prev = [3; 32];
    let out = tick(
        out.state,
        input(
            2,
            START + 20_000,
            vec![ph[0].next(START + 10_000, Vec::new(), Vec::new())],
        ),
    )
    .unwrap();
    assert_eq!(reasons(&out), vec![(0, Reject::Prev)]);
    ph[0].prev = good_prev;
    ph[0].seq = 1;
    let out = tick(
        out.state,
        input(
            3,
            START + 30_000,
            vec![ph[0].next(START + 10_000, Vec::new(), Vec::new())],
        ),
    )
    .unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn a_batch_for_another_match_is_rejected() {
    let (st, mut ph) = three();
    let mut b = ph[0].unsigned(START + 5_000, Vec::new(), Vec::new());
    b.match_id = [2; 16];
    let wrong = ph[0].seal(b, 1);
    let out = tick(st, input(1, START + 10_000, vec![wrong])).unwrap();
    assert_eq!(reasons(&out), vec![(0, Reject::WrongMatch)]);
}

#[test]
fn a_batch_dated_more_than_20_s_after_the_referee_clock_is_rejected_while_15_s_is_tolerated() {
    let (st, mut ph) = three();
    let t = START + 10_000;
    let batches = vec![
        ph[0].next(t, Vec::new(), Vec::new()),
        ph[1].next(t, Vec::new(), Vec::new()),
        ph[2].next(t + 30_000, Vec::new(), Vec::new()),
    ];
    let out = tick(st, input(1, t, batches)).unwrap();
    assert_eq!(
        reasons(&out),
        vec![(
            2,
            Reject::ClockSkew {
                t_ms: t + 30_000,
                now_ms: t
            }
        )]
    );
    let t = START + 20_000;
    let batches = vec![
        ph[0].next(t, Vec::new(), Vec::new()),
        ph[1].next(t, Vec::new(), Vec::new()),
        ph[2].next(t + 15_000, Vec::new(), Vec::new()),
    ];
    let out = tick(out.state, input(2, t, batches)).unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn in_a_two_player_match_each_clock_is_judged_alone_so_one_cannot_widen_the_other() {
    // Under a median of two, a phone 39 s ahead of its rival passed. Each clock now answers to
    // the referee clock only.
    let a = Phone::new(0, "a");
    let b = Phone::new(1, "b");
    let started = init(
        cfg(),
        vec![a.device("a"), b.device("b")],
        &K_M,
        &VRF,
        START,
        [0; 16],
    )
    .unwrap();
    let mut ph = [a, b];
    let t = START + 10_000;
    let batches = vec![
        ph[0].next(t - 5_000, Vec::new(), Vec::new()),
        ph[1].next(t + 34_000, Vec::new(), Vec::new()),
    ];
    let out = tick(started.state, input(1, t, batches)).unwrap();
    assert_eq!(
        reasons(&out),
        vec![(
            1,
            Reject::ClockSkew {
                t_ms: t + 34_000,
                now_ms: t
            }
        )]
    );
}

#[test]
fn batch_times_must_not_go_back_and_an_equal_time_passes() {
    let (st, mut ph) = three();
    let t = START + 10_000;
    let out = tick(st, input(1, t, vec![ph[0].next(t, Vec::new(), Vec::new())])).unwrap();
    let back = ph[0].next(t - 1, Vec::new(), Vec::new());
    let out = tick(out.state, input(2, t + 10_000, vec![back])).unwrap();
    assert_eq!(
        reasons(&out),
        vec![(
            0,
            Reject::BatchOrder {
                t_ms: t - 1,
                last_ms: t
            }
        )]
    );
    // The rejected batch still moved the chain on; the next one in order passes.
    let same = ph[0].next(t, Vec::new(), Vec::new());
    let out = tick(out.state, input(3, t + 20_000, vec![same])).unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn a_backlog_batch_is_accepted_while_it_is_inside_the_kept_epochs_and_older_is_too_old() {
    let (st, mut ph) = three();
    // A phone that was offline for three minutes delivers everything at once.
    let now = START + 200_000;
    let batches: Vec<BatchEnvelope> = (1..=40u64)
        .map(|k| {
            ph[0].next(
                START + k * 5_000,
                vec![fix(START + k * 5_000 - 1_000, 0)],
                Vec::new(),
            )
        })
        .collect();
    let out = tick(st, input(1, now, batches)).unwrap();
    // Epoch 13 is current, so evidence from epoch 1 on is kept: batches from 15 s on count.
    let oldest_ms = START + EPOCH_MS;
    let too_old: Vec<(u16, Reject)> = (1..=2u64)
        .map(|k| {
            (
                0,
                Reject::TooOld {
                    t_ms: START + k * 5_000,
                    oldest_ms,
                },
            )
        })
        .collect();
    assert_eq!(reasons(&out), too_old);
    let logged = out
        .log
        .iter()
        .filter(|e| matches!(e, LogEntry::Batch { .. }))
        .count();
    assert_eq!(logged, 38);
}

#[test]
fn fixes_must_move_forward_in_time() {
    let (st, mut ph) = three();
    let t = START + 10_000;
    let backwards = ph[0].next(t, vec![fix(t - 1_000, 0), fix(t - 2_000, 0)], Vec::new());
    let out = tick(st, input(1, t, vec![backwards])).unwrap();
    assert_eq!(reasons(&out), vec![(0, Reject::FixOrder)]);
    let forwards = ph[0].next(t + 5_000, vec![fix(t + 1_000, 0), fix(t + 2_000, 0)], Vec::new());
    let out = tick(out.state, input(2, t + 10_000, vec![forwards])).unwrap();
    assert_eq!(out.rejected, vec![]);
}

#[test]
fn stale_ticks_and_backward_clocks_are_refused_and_the_next_tick_runs() {
    let (st, _) = three();
    let out = tick(st, input(5, START + 50_000, Vec::new())).unwrap();
    let keep = out.state.clone();
    assert_eq!(
        tick(out.state, input(5, START + 60_000, Vec::new())).unwrap_err(),
        TickError::StaleTick { last: 5, got: 5 }
    );
    assert_eq!(
        tick(keep.clone(), input(6, START + 40_000, Vec::new())).unwrap_err(),
        TickError::ClockWentBack {
            last_ms: START + 50_000,
            now_ms: START + 40_000
        }
    );
    assert!(tick(keep, input(6, START + 60_000, Vec::new())).is_ok());
}

#[test]
fn checkpoints_land_every_minute_of_match_time_with_the_log_root() {
    let (mut st, _) = three();
    let mut cps = Vec::new();
    for k in 1..=13u32 {
        let out = tick(st, input(k, START + u64::from(k) * 10_000, Vec::new())).unwrap();
        for v in &out.verdicts {
            if let Verdict::Checkpoint { .. } = v.body {
                cps.push(k);
            }
        }
        st = out.state;
    }
    assert_eq!(cps, vec![6, 12]);
}

#[test]
fn finish_needs_the_match_to_be_over_and_the_committed_vrf_signature() {
    let (st, mut ph) = three();
    let alpha = "vrf:1:relay.testnet:01010101010101010101010101010101".to_owned();
    assert_eq!(
        finish(st.clone(), alpha.clone(), &VRF, [0; 16], Vec::new()).unwrap_err(),
        FinishError::NotOver
    );
    let b = ph[0].next(START + 600_000, Vec::new(), Vec::new());
    let out = tick(st, input(60, START + 600_000, vec![b])).unwrap();
    assert!(out.over);
    assert_eq!(out.state.phase(), Phase::Over);
    assert_eq!(
        tick(out.state.clone(), input(61, START + 610_000, Vec::new())).unwrap_err(),
        TickError::NotRunning
    );
    assert_eq!(
        finish(out.state.clone(), alpha.clone(), &[8; 64], [0; 16], Vec::new()).unwrap_err(),
        FinishError::VrfMismatch
    );
    let (size, root) = (out.state.log_size(), out.state.log_root());
    let fin = finish(out.state, alpha.clone(), &VRF, [1; 16], Vec::new()).unwrap();
    assert_eq!(
        fin.verdicts[0].body,
        Verdict::End {
            alpha: alpha.clone(),
            vrf_signature: VRF,
            log_size: size,
            root,
            hint_targets: vec![]
        }
    );
    assert_eq!(
        fin.state.log_size(),
        size + 1,
        "the End verdict joins the log after its root"
    );
    assert_eq!(
        finish(fin.state, alpha, &VRF, [0; 16], Vec::new()).unwrap_err(),
        FinishError::AlreadyEnded
    );
}

fn receipt(hint_id: u32) -> HintReceipt {
    HintReceipt {
        hint_id,
        chat_id: format!("chat-{hint_id}"),
        text_hash: [4; 32],
        signature: vec![1; 65],
        signing_address: "0x01".into(),
    }
}

#[test]
fn voice_receipts_join_the_log_once_and_only_for_hints_the_referee_issued() {
    let (st, mut ph) = three();
    let t = START + 10_000;
    let target = st.players()[0].target.unwrap();
    let mut batches = vec![ph[0].next(
        t,
        vec![fix(t - 1_000, 0)],
        vec![Action::Hint {
            hint: 0,
            nonce: 1,
            text: None,
        }],
    )];
    batches.insert(
        0,
        ph[target as usize].next(t, vec![fix(t - 1_000, 50)], Vec::new()),
    );
    let out = tick(st, input(1, t, batches)).unwrap();
    assert_eq!(out.hints.len(), 1);
    let id = out.hints[0].hint_id;
    let mut i = input(2, t + 10_000, Vec::new());
    i.receipts = vec![receipt(id + 1), receipt(id), receipt(id)];
    let out = tick(out.state, i).unwrap();
    let logged: Vec<&LogEntry> = out
        .log
        .iter()
        .filter(|e| matches!(e, LogEntry::HintReceipt { .. }))
        .collect();
    assert_eq!(logged.len(), 1);
    assert!(matches!(logged[0], LogEntry::HintReceipt { hint_id, .. } if *hint_id == id));
}

#[test]
fn the_sealed_state_round_trips_through_borsh_and_its_debug_form_hides_the_keys() {
    let (st, _) = three();
    let bytes = borsh::to_vec(&st).unwrap();
    let back: State = borsh::from_slice(&bytes).unwrap();
    assert_eq!(back, st);
    let k_tag = derive_tag_key(&K_M);
    // The bytes hold the keys (which is why the wrapper seals them) …
    assert!(bytes.windows(32).any(|w| w == k_tag));
    // … and Debug, which can end up in logs, never prints them.
    let shown = format!("{st:?}");
    assert!(shown.starts_with("State"));
    assert!(!shown.contains(&format!("{k_tag:?}")));
    assert!(!shown.contains(&format!("{VRF:?}")));
    assert!(!shown.contains(&format!("{:?}", derive_player_key(&K_M, 0))));
}

#[test]
fn a_match_longer_than_a_day_is_refused_and_one_of_a_day_starts() {
    let (a, b) = (Phone::new(0, "a"), Phone::new(1, "b"));
    let long = MatchConfig {
        duration_ms: referee_core::MAX_DURATION_MS + 1,
        ..cfg()
    };
    assert_eq!(
        init(
            long,
            vec![a.device("a"), b.device("b")],
            &K_M,
            &VRF,
            START,
            [0; 16]
        )
        .unwrap_err(),
        InitError::Duration(referee_core::MAX_DURATION_MS + 1)
    );
    let day = MatchConfig {
        duration_ms: referee_core::MAX_DURATION_MS,
        ..cfg()
    };
    assert!(init(
        day,
        vec![a.device("a"), b.device("b")],
        &K_M,
        &VRF,
        START,
        [0; 16]
    )
    .is_ok());
}

#[test]
fn absurd_times_cannot_crash_the_referee_and_play_goes_on() {
    let (st, mut ph) = three();
    let t = u64::MAX - 1;
    let mut fast = fix(t - 30_000, 0);
    fast.speed_cmps = u16::MAX;
    let mut faster = fix(t - 1, 0);
    faster.speed_cmps = u16::MAX;
    let actions = vec![
        Action::Strike { nonce: 1 },
        Action::Hint {
            hint: 1,
            nonce: 2,
            text: None,
        },
    ];
    // A device clock at the end of time is far ahead of the referee clock.
    let far = ph[0].next(t, vec![fast.clone(), faster.clone()], actions.clone());
    let out = tick(st, input(1, START + 10_000, vec![far])).unwrap();
    assert_eq!(
        reasons(&out),
        vec![(
            0,
            Reject::ClockSkew {
                t_ms: t,
                now_ms: START + 10_000
            }
        )]
    );
    let keep = out.state.clone();
    let out = tick(out.state, input(2, START + 20_000, Vec::new())).unwrap();
    assert_eq!(out.state.total_heads(), 3_000_000);
    // A referee clock there too (the caller cannot get it there, but the engine must cope):
    // every later rule runs on those times without overflowing, and the match is over.
    let b = ph[0].next(t, vec![fast, faster], actions);
    let out = tick(keep, input(2, t, vec![b])).unwrap();
    assert_eq!(out.rejected, vec![]);
    assert_eq!(out.refused.len(), 2);
    assert!(out
        .refused
        .iter()
        .all(|r| r.reason == referee_core::Refuse::TimeUp));
    assert!(out.over);
    assert_eq!(out.state.total_heads(), 3_000_000);
}

// ── who took an out player's head ─────────────────────────────────────────────────

const ACCOUNTS: [&str; 3] = ["a", "b", "c"];

/// Player indices in ring order: `ring[0]` hunts `ring[1]`, who hunts `ring[2]`.
fn ring_order() -> [u16; 3] {
    let order = ring::build_ring(&ACCOUNTS, &VRF);
    std::array::from_fn(|k| ACCOUNTS.iter().position(|a| *a == order[k]).unwrap() as u16)
}

/// What a phone heard of `other` over the ten seconds before `now`: a strong token for
/// every epoch those seconds touch.
fn heard(other: u16, now: u64) -> Vec<Sighting> {
    let k_tag = derive_tag_key(&K_M);
    let first = epoch_at(now - 9_999, START).unwrap();
    let last = epoch_at(now, START).unwrap();
    (first..=last)
        .map(|epoch| Sighting {
            epoch,
            token: beacon_token(&k_tag, &derive_player_key(&K_M, other), epoch),
            rssi_max: -60,
            rssi_med: -62,
            n: 3,
        })
        .collect()
}

/// One batch covering the ten seconds before `now`, a fix every 2.5 s, standing `north_m`
/// north of the zone centre.
fn walk(
    ph: &mut Phone,
    now: u64,
    north_m: i32,
    sightings: Vec<Sighting>,
    actions: Vec<Action>,
) -> BatchEnvelope {
    let fixes = (0..4).map(|k| fix(now - 7_500 + k * 2_500, north_m)).collect();
    let mut b = ph.unsigned(now, fixes, actions);
    b.sightings = sightings;
    let c = ph.counter + 1;
    ph.seal(b, c)
}

fn hud_of(out: &TickOutput, p: u16) -> &Hud {
    &out.huds.iter().find(|(q, _)| *q == p).unwrap().1
}

#[test]
fn a_tagged_players_hud_names_the_hunter_and_a_player_still_in_names_no_one() {
    let (mut st, mut ph) = three();
    let [h, t, by] = ring_order();
    for n in 1..=30u32 {
        let now = START + u64::from(n) * 10_000;
        // The hunter keeps striking; strikes before the lock builds are refused, not rejected.
        let strike = if n >= 6 {
            vec![Action::Strike { nonce: n }]
        } else {
            Vec::new()
        };
        let batches = vec![
            walk(&mut ph[h as usize], now, 0, heard(t, now), strike),
            walk(&mut ph[t as usize], now, 3, heard(h, now), Vec::new()),
            walk(&mut ph[by as usize], now, 800, Vec::new(), Vec::new()),
        ];
        let out = tick(st, input(n, now, batches)).unwrap();
        assert_eq!(out.rejected, vec![]);
        let tagged = out
            .verdicts
            .iter()
            .any(|v| matches!(v.body, Verdict::Tag { hunter, target, .. } if hunter == h && target == t));
        if !tagged {
            for p in [h, t, by] {
                assert_eq!(hud_of(&out, p).tagged_by, None, "player {p} is still in");
            }
            st = out.state;
            continue;
        }
        let gone = hud_of(&out, t);
        assert_eq!(gone.status, target_status::OUT);
        assert_eq!(gone.tagged_by.as_deref(), Some(ACCOUNTS[h as usize]));
        assert_eq!(hud_of(&out, h).tagged_by, None);
        assert_eq!(hud_of(&out, by).tagged_by, None);
        // The name stays on every later HUD, not only the one of the tagging tick.
        let later = tick(out.state, input(n + 1, now + 10_000, Vec::new())).unwrap();
        assert_eq!(hud_of(&later, t).tagged_by.as_deref(), Some(ACCOUNTS[h as usize]));
        return;
    }
    panic!("the hunter never landed the tag");
}

#[test]
fn a_forfeited_players_hud_names_the_account_that_received_the_head() {
    let (mut st, mut ph) = three();
    // ring[2] goes dark; its hunter, ring[1], receives the head. ring[0] is never involved.
    let [bystander, receiver, dark] = ring_order();
    for n in 1..=25u32 {
        let now = START + u64::from(n) * 10_000;
        let batches = vec![
            walk(&mut ph[bystander as usize], now, 0, Vec::new(), Vec::new()),
            walk(&mut ph[receiver as usize], now, 500, Vec::new(), Vec::new()),
        ];
        let out = tick(st, input(n, now, batches)).unwrap();
        assert_eq!(out.rejected, vec![]);
        if out.verdicts.iter().any(
            |v| matches!(v.body, Verdict::Forfeit { player, to, .. } if player == dark && to == receiver),
        ) {
            let gone = hud_of(&out, dark);
            assert_eq!(gone.status, target_status::OUT);
            assert_eq!(gone.tagged_by.as_deref(), Some(ACCOUNTS[receiver as usize]));
            assert_eq!(hud_of(&out, receiver).tagged_by, None);
            assert_eq!(hud_of(&out, bystander).tagged_by, None);
            return;
        }
        assert_eq!(hud_of(&out, dark).tagged_by, None, "still in until the forfeit");
        st = out.state;
    }
    panic!("the dark player never forfeited");
}

// ── presence, sightings, cooldown ─────────────────────────────────────────────────

fn fix_acc(t_ms: u64, acc_m: u16) -> Fix {
    Fix {
        acc_m,
        ..fix(t_ms, 0)
    }
}

#[test]
fn an_indoor_fix_keeps_its_player_present_and_approximate_location_counts_as_dark() {
    let (mut st, mut ph) = three();
    for n in 1..=9u32 {
        let now = START + u64::from(n) * 10_000;
        let batches = vec![
            ph[0].next(now, vec![fix_acc(now - 1_000, 200)], Vec::new()),
            ph[1].next(now, vec![fix_acc(now - 1_000, 201)], Vec::new()),
            ph[2].next(now, vec![fix_acc(now - 1_000, 5)], Vec::new()),
        ];
        st = tick(st, input(n, now, batches)).unwrap().state;
    }
    let dark: Vec<u64> = st.players().iter().map(|p| p.dark_ms).collect();
    assert_eq!(dark, vec![0, 90_000, 0]);
}

#[test]
fn a_stale_batch_counts_as_evidence_but_does_not_make_its_player_present() {
    let (mut st, mut ph) = three();
    // From the third tick on, so the late phone's batches are dated after the start.
    for n in 3..=11u32 {
        let now = START + u64::from(n) * 10_000;
        // Player 0's batches are dated 21 s behind the referee clock: valid, never about now.
        let batches = vec![
            ph[0].next(now - 21_000, vec![fix(now - 22_000, 0)], Vec::new()),
            ph[1].next(now, vec![fix(now - 1_000, 0)], Vec::new()),
        ];
        let out = tick(st, input(n, now, batches)).unwrap();
        assert_eq!(out.rejected, vec![]);
        st = out.state;
    }
    let dark: Vec<u64> = st.players().iter().map(|p| p.dark_ms).collect();
    assert_eq!(dark, vec![110_000, 0, 110_000]);
}

fn contacts(out: &TickOutput) -> usize {
    out.log
        .iter()
        .filter(|e| matches!(e, LogEntry::Contact { .. }))
        .count()
}

#[test]
fn a_token_listed_three_times_in_one_batch_counts_once() {
    let [h, t, _] = ring_order();
    let run = |copies: usize, n: u8| {
        let (st, mut ph) = three();
        let now = START + 10_000;
        let weak: Vec<Sighting> = heard(t, now)
            .into_iter()
            .flat_map(|s| std::iter::repeat_n(Sighting { n, ..s }, copies))
            .collect();
        let batches = vec![
            walk(&mut ph[h as usize], now, 0, weak, Vec::new()),
            walk(&mut ph[t as usize], now, 3, heard(h, now), Vec::new()),
        ];
        contacts(&tick(st, input(1, now, batches)).unwrap())
    };
    assert_eq!(run(3, 1), 0, "three copies of one sample are one sample");
    assert!(run(1, 2) > 0, "two real samples are enough");
}

#[test]
fn the_hint_cooldown_runs_on_the_referee_clock_whatever_the_device_says() {
    let (st, mut ph) = three();
    let [asker, target, _] = ring_order();
    let hint = |nonce| Action::Hint {
        hint: 0,
        nonce,
        text: None,
    };
    let mut now = START + 10_000;
    let batches = |ph: &mut Vec<Phone>, now: u64, device: u64, nonce| {
        vec![
            ph[asker as usize].next(device, vec![fix(device - 1_000, 0)], vec![hint(nonce)]),
            ph[target as usize].next(now, vec![fix(now - 1_000, 50)], Vec::new()),
        ]
    };
    let out = tick(st, input(1, now, batches(&mut ph, now, now, 1))).unwrap();
    assert_eq!(out.hints.len(), 1);
    // Ten seconds later by the referee, but the device clock claims 39 s have passed.
    now += 10_000;
    let out = tick(out.state, input(2, now, batches(&mut ph, now, now + 19_000, 2))).unwrap();
    assert_eq!(
        out.refused[0].reason,
        referee_core::Refuse::Cooldown {
            ready_ms: START + 40_000
        }
    );
    now += 20_000;
    let out = tick(out.state, input(3, now, batches(&mut ph, now, now + 19_000, 3))).unwrap();
    assert_eq!(out.hints.len(), 1);
}

// ── protocol v2: the log, the verdict chain, proofs, HUD v2 ──────────────────────

#[test]
fn every_tick_logs_its_tick_first_even_an_empty_one_and_verdicts_chain_by_prev() {
    let (mut st, _) = three();
    let mut prev = st.last_verdict_digest();
    for k in 1..=7u32 {
        let now = START + u64::from(k) * 10_000;
        let out = tick(st, input(k, now, Vec::new())).unwrap();
        assert_eq!(
            out.log[0],
            LogEntry::Tick {
                tick_no: k,
                now_ms: now,
                call_id: [k as u8; 16]
            }
        );
        for v in &out.verdicts {
            assert_eq!(v.prev, prev, "verdict {} links to the one before", v.seq);
            prev = verdict_digest(v);
        }
        assert_eq!(out.state.last_verdict_digest(), prev);
        st = out.state;
    }
}

#[test]
fn a_refused_batch_is_logged_with_its_hash_and_code_and_only_an_authentic_one_reaches_the_hud() {
    use tail_protocol::reject_code;
    let (st, mut ph) = three();
    let t = START + 10_000;
    // Player 1's batch is forged (another device's assertion); player 2's is authentic but
    // dated 30 s ahead.
    let b = ph[1].unsigned(t, Vec::new(), Vec::new());
    let forged = BatchEnvelope {
        batch: b.clone(),
        assertion: appattest::sign_assertion(&ph[0].sk, &batch_client_data_hash(&b), APP, 1),
    };
    let ahead = ph[2].next(t + 30_000, Vec::new(), Vec::new());
    let ahead_hash = batch_hash(&ahead.batch);
    let out = tick(st, input(1, t, vec![forged, ahead])).unwrap();
    let logged: Vec<&LogEntry> = out
        .log
        .iter()
        .filter(|e| matches!(e, LogEntry::Rejected { .. }))
        .collect();
    assert_eq!(
        logged,
        vec![
            &LogEntry::Rejected {
                player: 1,
                seq: 0,
                hash: batch_hash(&b),
                code: reject_code::ASSERTION
            },
            &LogEntry::Rejected {
                player: 2,
                seq: 0,
                hash: ahead_hash,
                code: reject_code::CLOCK_SKEW
            },
        ]
    );
    assert_eq!(
        hud_of(&out, 1).rejected,
        None,
        "a forged batch says nothing about player 1"
    );
    assert_eq!(hud_of(&out, 2).rejected, Some((0, reject_code::CLOCK_SKEW)));
    // The authentic batch moved player 2's chain on; the HUD says where it stands.
    assert_eq!(
        (hud_of(&out, 2).next_seq, hud_of(&out, 2).chain_tip),
        (1, ph[2].prev)
    );
    assert_eq!(
        (hud_of(&out, 1).next_seq, hud_of(&out, 1).chain_tip),
        (0, [0; 32])
    );
}

#[test]
fn every_checkpoint_and_the_end_carry_a_proof_from_the_last_anchor_that_the_full_log_confirms() {
    use tail_protocol::merkle;
    let mut ph = vec![Phone::new(0, "a"), Phone::new(1, "b"), Phone::new(2, "c")];
    let devices = ["a", "b", "c"]
        .iter()
        .zip(&ph)
        .map(|(n, p)| p.device(n))
        .collect();
    let started = init(cfg(), devices, &K_M, &VRF, START, [0; 16]).unwrap();
    let mut leaves: Vec<Hash> = started.log.iter().map(merkle::leaf).collect();
    let mut anchored = (0u64, merkle::empty_root());
    let mut check = |verdicts: &[tail_protocol::VerdictPayload],
                     proofs: &[referee_core::ConsistencyProof],
                     log: &[LogEntry],
                     leaves: &mut Vec<Hash>| {
        leaves.extend(log.iter().map(merkle::leaf));
        let roots: Vec<_> = verdicts
            .iter()
            .filter_map(|v| match &v.body {
                Verdict::Checkpoint { log_size, root } | Verdict::End { log_size, root, .. } => {
                    Some((v.seq, *log_size, *root))
                }
                _ => None,
            })
            .collect();
        assert_eq!(roots.len(), proofs.len(), "one proof per anchored root");
        for ((seq, size, root), p) in roots.into_iter().zip(proofs) {
            assert_eq!(p.seq, seq);
            assert_eq!(p.from_size, anchored.0, "from the last anchored size");
            let n = usize::try_from(size).unwrap();
            assert_eq!(merkle::root(&leaves[..n]), root);
            assert!(merkle::verify_consistency(
                p.from_size,
                size,
                &anchored.1,
                &root,
                &p.path
            ));
            let m = usize::try_from(p.from_size).unwrap();
            assert_eq!(p.path, merkle::consistency_proof(&leaves[..n], m));
            assert!(size > anchored.0, "the log size grows from anchor to anchor");
            anchored = (size, root);
        }
    };
    let mut st = started.state;
    let mut checkpoints = 0;
    for k in 1..=30u32 {
        let now = START + u64::from(k) * 10_000;
        // Everyone stays present, apart and out of contact, so the match runs its full time.
        let batches = (0..3)
            .zip([0, 400, 800])
            .map(|(i, north_m)| walk(&mut ph[i], now, north_m, Vec::new(), Vec::new()))
            .collect();
        let out = tick(st, input(k, now, batches)).unwrap();
        checkpoints += out.proofs.len();
        check(&out.verdicts, &out.proofs, &out.log, &mut leaves);
        st = out.state;
    }
    assert_eq!(checkpoints, 5);
    let out = tick(st, input(60, START + 600_000, Vec::new())).unwrap();
    assert!(out.over && out.proofs.is_empty());
    check(&out.verdicts, &out.proofs, &out.log, &mut leaves);
    let alpha = "vrf:1:relay.testnet:01010101010101010101010101010101".to_owned();
    let fin = finish(out.state, alpha, &VRF, [1; 16], Vec::new()).unwrap();
    assert_eq!(fin.proofs.len(), 1);
    check(&fin.verdicts, &fin.proofs, &fin.log, &mut leaves);
    assert_eq!(fin.state.log_size(), leaves.len() as u64);
}

#[test]
fn a_tag_is_logged_right_after_the_evidence_that_justifies_its_lock() {
    use tail_protocol::{LOCK_EPOCHS, WINDOW_EPOCHS};
    let (mut st, mut ph) = three();
    let [h, t, by] = ring_order();
    let mut log = Vec::new();
    for n in 1..=30u32 {
        let now = START + u64::from(n) * 10_000;
        let strike = if n >= 6 {
            vec![Action::Strike { nonce: n }]
        } else {
            Vec::new()
        };
        let batches = vec![
            walk(&mut ph[h as usize], now, 0, heard(t, now), strike),
            walk(&mut ph[t as usize], now, 3, heard(h, now), Vec::new()),
            walk(&mut ph[by as usize], now, 800, Vec::new(), Vec::new()),
        ];
        let out = tick(st, input(n, now, batches)).unwrap();
        log.extend(out.log.iter().cloned());
        let tagged = out
            .verdicts
            .iter()
            .find(|v| matches!(v.body, Verdict::Tag { hunter, target, .. } if hunter == h && target == t));
        if let Some(v) = tagged {
            let at = log
                .iter()
                .position(|e| matches!(e, LogEntry::Verdict { seq, .. } if *seq == v.seq))
                .unwrap();
            let LogEntry::Evidence {
                hunter,
                target,
                strike_seq,
                strike_epoch,
                epochs,
                ..
            } = &log[at - 1]
            else {
                panic!("the entry before the Tag is {:?}", log[at - 1]);
            };
            assert_eq!((*hunter, *target), (h, t));
            assert_eq!(
                *strike_seq,
                ph[h as usize].seq - 1,
                "the batch that carried the strike"
            );
            assert!(epochs.len() as u32 >= LOCK_EPOCHS, "{epochs:?}");
            let (a, b) = (h.min(t), h.max(t));
            for e in epochs {
                assert!(
                    *e <= *strike_epoch && strike_epoch - e < WINDOW_EPOCHS,
                    "{e} in the window"
                );
                assert!(
                    log.iter()
                        .any(|x| matches!(*x, LogEntry::Contact { a: xa, b: xb, epoch, .. }
                        if (xa, xb, epoch) == (a, b, *e))),
                    "contact in epoch {e} is logged"
                );
            }
            assert!(epochs.contains(strike_epoch) || epochs.contains(&(strike_epoch - 1)));
            assert_eq!(hud_of(&out, h).tags, 1);
            assert_eq!(hud_of(&out, t).tags, 0);
            return;
        }
        st = out.state;
    }
    panic!("the hunter never landed the tag");
}

#[test]
fn the_hud_carries_the_log_at_the_end_of_its_tick() {
    let (st, mut ph) = three();
    let t = START + 10_000;
    let out = tick(
        st,
        input(1, t, vec![ph[0].next(t, vec![fix(t - 1_000, 0)], Vec::new())]),
    )
    .unwrap();
    for p in 0..3u16 {
        let hud = hud_of(&out, p);
        assert_eq!((hud.match_id, hud.player), (MATCH, p));
        assert_eq!(
            (hud.log_size, hud.root),
            (out.state.log_size(), out.state.log_root())
        );
    }
    assert_eq!(hud_of(&out, 0).next_seq, 1);
    assert_eq!(hud_of(&out, 0).chain_tip, ph[0].prev);
}
