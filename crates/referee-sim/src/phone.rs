//! A simulated phone: what the app does every second (fix, scan) and every `BATCH_MS` (build,
//! chain, assert). Tokens, borsh, the hash chain and App Attest assertions are the real ones,
//! so every check in the referee runs on the same code path as in a match.

use p256::ecdsa::SigningKey;
use std::collections::BTreeMap;
use tail_protocol::beacon::{beacon_token, epoch_at, tag_matches};
use tail_protocol::digest::{batch_client_data_hash, batch_hash, sha256};
use tail_protocol::{Action, Batch, BatchEnvelope, Fix, Hash, Hud, PlayerKeys, Sighting, Token};

#[derive(Debug)]
pub struct Phone {
    pub name: String,
    pub index: u16,
    pub keys: PlayerKeys,
    signing_key: SigningKey,
    app_id: String,
    seq: u32,
    prev: Hash,
    counter: u32,
    fixes: Vec<Fix>,
    heard: BTreeMap<(u32, Token), Vec<i8>>,
    actions: Vec<Action>,
    nonce: u32,
    pub clock_offset_ms: i64,
    pub batch_phase_s: u64,
    /// How many times each sighting is listed in a batch (1 for an honest app).
    pub sighting_copies: u8,
    pub last_hud: Option<Hud>,
}

/// A deterministic P-256 key per simulated device (a real one lives in the Secure Enclave).
pub fn device_key(name: &str) -> SigningKey {
    (0u32..)
        .find_map(|i| {
            SigningKey::from_slice(&sha256(&[b"tail/sim/device", name.as_bytes(), &i.to_le_bytes()])).ok()
        })
        .expect("some hash is a valid scalar")
}

impl Phone {
    pub fn new(name: String, index: u16, keys: PlayerKeys, app_id: String) -> Self {
        Self {
            signing_key: device_key(&name),
            name,
            index,
            keys,
            app_id,
            seq: 0,
            prev: [0; 32],
            counter: 0,
            fixes: Vec::new(),
            heard: BTreeMap::new(),
            actions: Vec::new(),
            nonce: 0,
            clock_offset_ms: 0,
            batch_phase_s: 0,
            sighting_copies: 1,
            last_hud: None,
        }
    }

    pub fn out(&self) -> bool {
        self.last_hud
            .as_ref()
            .is_some_and(|h| h.status == tail_protocol::target_status::OUT)
    }

    pub fn device_ms(&self, t_ms: u64) -> u64 {
        t_ms.saturating_add_signed(self.clock_offset_ms)
    }

    fn epoch(&self, t_ms: u64) -> Option<u32> {
        epoch_at(self.device_ms(t_ms), self.keys.start_ms)
    }

    /// The token this phone advertises at sim time `t_ms`, by its own clock.
    pub fn token(&self, t_ms: u64) -> Option<Token> {
        self.epoch(t_ms)
            .map(|e| beacon_token(&self.keys.k_tag, &self.keys.k_player, e))
    }

    /// Like `token`, for another epoch (to model a recorded and replayed token).
    pub fn token_at_epoch(&self, epoch: u32) -> Token {
        beacon_token(&self.keys.k_tag, &self.keys.k_player, epoch)
    }

    pub fn fix(&mut self, fix: Fix) {
        self.fixes.push(fix);
    }

    /// An honest scan: only tokens whose tag is from this match and epochs e−1..e+1 are kept.
    pub fn hear(&mut self, t_ms: u64, token: Token, rssi: i8) {
        if let Some(e) = self.epoch(t_ms) {
            if tag_matches(&self.keys.k_tag, &token, e) {
                self.heard.entry((e, token)).or_default().push(rssi);
            }
        }
    }

    /// A scan that skips the tag filter: what a modified scanner or a relay attack would feed
    /// the referee. The referee must cope on its own.
    pub fn hear_unfiltered(&mut self, t_ms: u64, token: Token, rssi: i8) {
        if let Some(e) = self.epoch(t_ms) {
            self.heard.entry((e, token)).or_default().push(rssi);
        }
    }

    pub fn strike(&mut self) {
        self.nonce += 1;
        self.actions.push(Action::Strike { nonce: self.nonce });
    }

    pub fn hint(&mut self, hint: u8, text: Option<String>) {
        self.nonce += 1;
        self.actions.push(Action::Hint {
            hint,
            nonce: self.nonce,
            text,
        });
    }

    /// Builds, chains and asserts the next batch from everything gathered since the last one.
    pub fn batch(&mut self, t_ms: u64) -> BatchEnvelope {
        let copies = usize::from(self.sighting_copies.max(1));
        let sightings = std::mem::take(&mut self.heard)
            .into_iter()
            .flat_map(|((epoch, token), mut rssi)| {
                rssi.sort_unstable();
                let s = Sighting {
                    epoch,
                    token,
                    rssi_max: *rssi.last().expect("at least one sample"),
                    rssi_med: rssi[rssi.len() / 2],
                    n: rssi.len().min(255) as u8,
                };
                std::iter::repeat_n(s, copies)
            })
            .collect();
        let batch = Batch {
            match_id: self.keys.match_id,
            player: self.index,
            seq: self.seq,
            prev: self.prev,
            t_ms: self.device_ms(t_ms),
            fixes: std::mem::take(&mut self.fixes),
            sightings,
            actions: std::mem::take(&mut self.actions),
        };
        self.counter += 1;
        let assertion = appattest::sign_assertion(
            &self.signing_key,
            &batch_client_data_hash(&batch),
            &self.app_id,
            self.counter,
        );
        self.seq += 1;
        self.prev = batch_hash(&batch);
        BatchEnvelope { batch, assertion }
    }

    /// Phone-side view of whether it is time to batch at whole sim second `s`.
    pub fn batches_at(&self, s: u64) -> bool {
        s > self.batch_phase_s && (s - self.batch_phase_s).is_multiple_of(tail_protocol::BATCH_MS / 1000)
    }
}
