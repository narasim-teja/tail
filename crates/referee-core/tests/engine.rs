//! Engine-level rules that do not need a whole simulated match: init, the Start verdict, batch
//! authenticity, tick ordering, finish, receipts and the sealed state. Each rejection test has a
//! twin where the one broken input is fixed and the batch goes through.

use p256::ecdsa::SigningKey;
use referee_core::{
    finish, init, tick, Circle, Device, FinishError, HintReceipt, InitError, MatchConfig, Phase, Reject,
    State, TickError, TickInput, TickOutput,
};
use tail_protocol::beacon::{derive_player_key, derive_tag_key};
use tail_protocol::digest::{batch_client_data_hash, batch_hash, verdict_digest};
use tail_protocol::{ring, Action, Batch, BatchEnvelope, Fix, Hash, LogEntry, Verdict};

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
    assert_eq!(
        s.log,
        vec![LogEntry::Verdict {
            seq: 1,
            digest: verdict_digest(v)
        }]
    );
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
fn a_clock_more_than_20_s_from_the_median_is_rejected_while_15_s_is_tolerated() {
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
                median_ms: t
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
            root
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
fn absurd_device_times_cannot_crash_the_referee_and_play_goes_on() {
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
    // Alone in its tick, the batch is its own median, so only the later rules can stop it.
    let out = tick(
        st,
        input(
            1,
            START + 10_000,
            vec![ph[0].next(t, vec![fast, faster], actions)],
        ),
    )
    .unwrap();
    assert_eq!(out.rejected, vec![]);
    assert!(out
        .refused
        .iter()
        .all(|r| r.reason == referee_core::Refuse::TimeUp));
    assert_eq!(out.refused.len(), 2);
    let out = tick(out.state, input(2, START + 20_000, Vec::new())).unwrap();
    assert_eq!(out.state.total_heads(), 3_000_000);
}
