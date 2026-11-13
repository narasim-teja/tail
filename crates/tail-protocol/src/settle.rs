//! The settlement replay: what the contract checks at `End` before any money in a match becomes
//! withdrawable (TECHNICAL 4.10). During play the contract applies each Hint, Tag and Forfeit as
//! it lands but cannot check it: the ring is still secret, and a Hint does not say whom it was
//! about. `End` reveals both (the VRF signature and `hint_targets`), and this replays the match
//! in verdict order against them. The contract, the referee's verifier and the web replay all
//! run this one rule (the TypeScript twin is `packages/protocol/src/settle.ts`).

use borsh::{BorshDeserialize, BorshSerialize};

/// A Hint, Tag or Forfeit as the contract applied it, in verdict order.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "schema", derive(borsh::BorshSchema))]
pub enum PlayEvent {
    /// `amount` went from `from`'s head into the hint pool.
    Hint { from: u16, amount: u128 },
    /// `credit` went from the pool onto `target`'s head, then the head to `hunter`.
    Tag { hunter: u16, target: u16, credit: u128 },
    /// `credit` went from the pool onto `player`'s head, then the head to `to`.
    Forfeit { player: u16, to: u16, credit: u128 },
}

/// Which rule the replay found broken. Appended, never reordered: the contract stores it.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "schema", derive(borsh::BorshSchema))]
pub enum Check {
    /// `End` names a different number of hint targets than the match has hints.
    HintCount,
    /// A hint was not about its asker's target at that moment.
    HintTarget,
    /// A Tag was not a hunter taking its current target.
    TagRing,
    /// A Forfeit did not pay the forfeiter's hunter.
    ForfeitRing,
    /// A Tag or Forfeit credit is not what hints paid onto its target and nobody was credited.
    Credit,
    /// The hint pool does not end at 0 once every survivor has their credit.
    Pool,
}

/// The first rule the replay found broken, and at which event (`None` for a whole-match check).
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "schema", derive(borsh::BorshSchema))]
pub struct Violation {
    pub check: Check,
    pub event: Option<u32>,
}

impl Violation {
    /// Plain words for the contract's view and logs; the web replay says the same.
    pub fn describe(&self) -> String {
        let what = match self.check {
            Check::HintCount => "End names a different number of hint targets than there were hints",
            Check::HintTarget => "a hint was not about its asker's target",
            Check::TagRing => "a Tag did not follow the ring",
            Check::ForfeitRing => "a Forfeit did not pay the forfeiter's hunter",
            Check::Credit => "a credit is not the hints paid onto its target",
            Check::Pool => "the hint pool does not end at 0",
        };
        match self.event {
            Some(i) => format!("event {i}: {what}"),
            None => what.to_owned(),
        }
    }
}

/// Replays `events` against the ring (player indices in ring order: `ring[k]` hunts
/// `ring[k+1 mod n]`) and the revealed `hint_targets` (one per Hint, in order). Every Tag and
/// Forfeit must follow the ring, every hint must be about its asker's current target, and every
/// credit must equal the hints paid onto that target and not yet credited. The winner of each
/// elimination then hunts the loser's target. Returns what each player is still owed from the
/// pool at End (their pending credit if they survived, else 0), which must add up to `pool`.
pub fn replay(
    ring: &[u16],
    events: &[PlayEvent],
    hint_targets: &[u16],
    pool: u128,
) -> Result<Vec<u128>, Violation> {
    let n = ring.len();
    let mut target: Vec<Option<u16>> = vec![None; n];
    for (k, &h) in ring.iter().enumerate() {
        target[usize::from(h)] = Some(ring[(k + 1) % n]);
    }
    let hints = events
        .iter()
        .filter(|e| matches!(e, PlayEvent::Hint { .. }))
        .count();
    if hints != hint_targets.len() {
        return Err(Violation {
            check: Check::HintCount,
            event: None,
        });
    }
    let mut pending = vec![0u128; n];
    let mut out = vec![false; n];
    let mut about = hint_targets.iter();
    for (i, e) in events.iter().enumerate() {
        let at = |check| Violation {
            check,
            event: Some(u32::try_from(i).expect("fewer than 2^32 events")),
        };
        let current = |p: u16| target.get(usize::from(p)).copied().flatten();
        let (winner, loser, credit, ring_check) = match *e {
            PlayEvent::Hint { from, amount } => {
                let t = *about.next().expect("counted above");
                if current(from) != Some(t) {
                    return Err(at(Check::HintTarget));
                }
                pending[usize::from(t)] += amount;
                continue;
            }
            PlayEvent::Tag {
                hunter,
                target,
                credit,
            } => (hunter, target, credit, Check::TagRing),
            PlayEvent::Forfeit { player, to, credit } => (to, player, credit, Check::ForfeitRing),
        };
        // Only a live player is anyone's target, and an out player hunts nobody, so this also
        // keeps both sides of the elimination in.
        if current(winner) != Some(loser) {
            return Err(at(ring_check));
        }
        let (w, l) = (usize::from(winner), usize::from(loser));
        if credit != pending[l] {
            return Err(at(Check::Credit));
        }
        pending[l] = 0;
        out[l] = true;
        target[w] = target[l].take().filter(|&t| t != winner);
    }
    let owed: Vec<u128> = (0..n).map(|p| if out[p] { 0 } else { pending[p] }).collect();
    if owed.iter().sum::<u128>() != pool {
        return Err(Violation {
            check: Check::Pool,
            event: None,
        });
    }
    Ok(owed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ring 0 → 1 → 2 → 0.
    const RING: [u16; 3] = [0, 1, 2];

    fn hint(from: u16, amount: u128) -> PlayEvent {
        PlayEvent::Hint { from, amount }
    }
    fn tag(hunter: u16, target: u16, credit: u128) -> PlayEvent {
        PlayEvent::Tag {
            hunter,
            target,
            credit,
        }
    }
    fn fail(check: Check, event: Option<u32>) -> Result<Vec<u128>, Violation> {
        Err(Violation { check, event })
    }

    #[test]
    fn an_honest_match_owes_each_survivor_the_hints_paid_onto_them() {
        // 0 asks about 1 twice, 2 asks about 0, then 0 takes 1 (crediting 1's 30 first).
        let events = [hint(0, 10), hint(0, 20), hint(2, 5), tag(0, 1, 30)];
        assert_eq!(replay(&RING, &events, &[1, 1, 0], 5), Ok(vec![5, 0, 0]));
    }

    #[test]
    fn the_winner_hunts_the_losers_target_next() {
        // 0 takes 1 and inherits 2; a hint by 0 is now about 2.
        let events = [tag(0, 1, 0), hint(0, 7), tag(0, 2, 7)];
        assert_eq!(replay(&RING, &events, &[2], 0), Ok(vec![0, 0, 0]));
        assert_eq!(replay(&RING, &events, &[1], 0), fail(Check::HintTarget, Some(1)));
    }

    #[test]
    fn an_off_ring_tag_is_a_violation() {
        assert_eq!(
            replay(&RING, &[tag(0, 2, 0)], &[], 0),
            fail(Check::TagRing, Some(0))
        );
    }

    #[test]
    fn a_forfeit_to_anyone_but_the_hunter_is_a_violation() {
        let f = PlayEvent::Forfeit {
            player: 1,
            to: 2,
            credit: 0,
        };
        assert_eq!(replay(&RING, &[f], &[], 0), fail(Check::ForfeitRing, Some(0)));
    }

    #[test]
    fn a_hint_about_someone_other_than_the_askers_target_is_a_violation() {
        assert_eq!(
            replay(&RING, &[hint(0, 10)], &[2], 10),
            fail(Check::HintTarget, Some(0))
        );
    }

    #[test]
    fn a_credit_other_than_the_pending_total_is_a_violation() {
        let events = [hint(0, 10), tag(0, 1, 9)];
        assert_eq!(replay(&RING, &events, &[1], 1), fail(Check::Credit, Some(1)));
        let events = [hint(0, 10), tag(0, 1, 11)];
        assert_eq!(replay(&RING, &events, &[1], 0), fail(Check::Credit, Some(1)));
    }

    #[test]
    fn a_hint_target_list_of_the_wrong_length_is_a_violation() {
        assert_eq!(
            replay(&RING, &[hint(0, 10)], &[], 10),
            fail(Check::HintCount, None)
        );
        assert_eq!(
            replay(&RING, &[hint(0, 10)], &[1, 1], 10),
            fail(Check::HintCount, None)
        );
    }

    #[test]
    fn a_pool_that_is_not_what_the_survivors_are_owed_is_a_violation() {
        // Unreachable through the contract (its pool follows the same credits); the check keeps
        // the replay from paying out anything it did not account for.
        assert_eq!(replay(&RING, &[hint(0, 10)], &[1], 11), fail(Check::Pool, None));
    }

    #[test]
    fn a_player_index_outside_the_ring_is_a_violation_not_a_panic() {
        assert_eq!(
            replay(&RING, &[tag(7, 1, 0)], &[], 0),
            fail(Check::TagRing, Some(0))
        );
        assert_eq!(
            replay(&RING, &[hint(9, 1)], &[1], 1),
            fail(Check::HintTarget, Some(0))
        );
    }

    #[test]
    fn violations_describe_the_event_they_happened_at() {
        let v = Violation {
            check: Check::TagRing,
            event: Some(3),
        };
        assert_eq!(v.describe(), "event 3: a Tag did not follow the ring");
    }
}
