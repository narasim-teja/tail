//! The local backend of `host`: the local test referee. The same command code runs as a native
//! process that the relay spawns once per command, with its keys and storage in a directory on
//! the developer's machine. It is NOT an enclave: whoever can read that directory holds the
//! referee's keys, and no attestation backs what it signs. It exists so a match can be played
//! when OutLayer is unreachable, and the matches it judges must be labelled as such.
//!
//! Layout of `TAIL_LOCAL_REFEREE_DIR` (directories 0700, files 0600):
//! - `verdict.key`, `vrf.key`: ed25519 seeds; `state.key`: the XChaCha20-Poly1305 state key
//! - `storage/{hex(key)}`: one file per storage record
//! - `storage.lock`: the advisory lock that serialises storage writes
//! - `tmp/`: files being written, renamed or linked into place once complete

use super::Vrf;
use crate::codec::uuid_string;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::Value;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Directory of the local referee's keys and storage. Required: a referee that quietly made
/// fresh keys somewhere else would sign under a key nobody pinned.
const DIR_VAR: &str = "TAIL_LOCAL_REFEREE_DIR";
/// Stands in for the worker-set sender in the VRF alpha.
const OWNER_VAR: &str = "TAIL_LOCAL_REFEREE_OWNER";
/// The sender named in the VRF alpha when `TAIL_LOCAL_REFEREE_OWNER` is unset.
const DEFAULT_OWNER: &str = "local-test-referee";

const VERDICT_KEY: &str = "verdict.key";
const VRF_KEY: &str = "vrf.key";
const STATE_KEY: &str = "state.key";
const NONCE_LEN: usize = 24;

/// The call's input: one JSON object on stdin, as the OutLayer worker delivers it.
pub fn input_json() -> Result<Option<Value>, serde_json::Error> {
    let mut buf = Vec::new();
    // Same as the OutLayer SDK: unreadable stdin counts as no input.
    io::stdin().read_to_end(&mut buf).unwrap_or(0);
    if buf.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(&buf).map(Some)
}

/// The call's answer, on stdout, in the same shape the OutLayer worker returns.
pub fn output_json(value: &Value) -> Result<(), serde_json::Error> {
    let json = serde_json::to_vec(value)?;
    let mut out = io::stdout().lock();
    // As in the OutLayer SDK: if stdout is gone there is nobody left to tell.
    let _ = out.write_all(&json);
    let _ = out.flush();
    Ok(())
}

/// The process's environment stands in for the author secret rows.
pub fn author_secret(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Always allowed. Locally the process boundary is the trust boundary: only the relay spawns
/// this binary, and anyone who can spawn it can read its key directory anyway.
#[expect(clippy::unnecessary_wraps, reason = "same signature as the OutLayer backend")]
pub fn require_owner() -> Result<(), String> {
    Ok(())
}

/// One process is one call, so the call id is drawn once: a random v4 UUID string, standing in
/// for the worker's `OUTLAYER_CALL_ID` and read the same way. It names no attestation record.
pub fn call_id() -> Result<[u8; 16], String> {
    static ID: OnceLock<String> = OnceLock::new();
    let id = ID.get_or_init(|| {
        let mut b: [u8; 16] = random();
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        uuid_string(&b)
    });
    crate::codec::uuid_bytes(id)
}

/// Secret randomness from the OS CSPRNG.
pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the OS random number generator is available");
    out
}

fn dir() -> Result<PathBuf, String> {
    let root = std::env::var_os(DIR_VAR)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("{DIR_VAR} is not set: the local test referee keeps its keys there"))?;
    let mut builder = DirBuilder::new();
    builder.recursive(true).mode(0o700);
    for sub in ["storage", "tmp"] {
        let path = root.join(sub);
        builder
            .create(&path)
            .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    }
    Ok(root)
}

fn read_opt(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Writes `bytes` to a fresh 0600 file under `tmp/` and returns its path. Records only ever
/// reach their final name complete (by rename or link), so a reader never sees half a file.
fn write_temp(root: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = root
        .join("tmp")
        .join(format!("{}-{}", std::process::id(), hex::encode(random::<8>())));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    f.write_all(bytes)
        .and_then(|()| f.sync_all())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path)
}

/// Puts `bytes` at `path` only if nothing is there; false if something already was. A hard
/// link fails on an existing name, so of two concurrent first writers exactly one wins.
fn create_if_absent(root: &Path, path: &Path, bytes: &[u8]) -> Result<bool, String> {
    let tmp = write_temp(root, bytes)?;
    let linked = fs::hard_link(&tmp, path);
    // The temp name is only a staging handle; the record lives on under its final name.
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(format!("cannot create {}: {e}", path.display())),
    }
}

/// Replaces whatever is at `path` in one step.
fn replace(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = write_temp(root, bytes)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot write {}: {e}", path.display())
    })
}

/// A 32-byte secret, generated and persisted on first use.
fn secret_key(name: &str) -> Result<[u8; 32], String> {
    let root = dir()?;
    let path = root.join(name);
    let bytes = if let Some(v) = read_opt(&path)? {
        v
    } else {
        let fresh: [u8; 32] = random();
        if create_if_absent(&root, &path, &fresh)? {
            return Ok(fresh);
        }
        // Another process created it first; its key is the key.
        read_opt(&path)?.ok_or_else(|| format!("{} vanished between two reads", path.display()))?
    };
    bytes
        .try_into()
        .map_err(|v: Vec<u8>| format!("{} is {} bytes, expected 32", path.display(), v.len()))
}

fn signing_key(name: &str) -> Result<SigningKey, String> {
    Ok(SigningKey::from_bytes(&secret_key(name)?))
}

pub fn referee_pk() -> Result<[u8; 32], String> {
    Ok(signing_key(VERDICT_KEY)?.verifying_key().to_bytes())
}

/// Signs a 32-byte digest that this module composed under one of its fixed domains. Never
/// pass caller bytes here: the key is the referee's voice.
pub fn sign_digest(digest: &[u8; 32]) -> Result<[u8; 64], String> {
    Ok(signing_key(VERDICT_KEY)?.sign(digest).to_bytes())
}

fn state_cipher() -> Result<XChaCha20Poly1305, String> {
    let key = secret_key(STATE_KEY)?;
    XChaCha20Poly1305::new_from_slice(&key).map_err(|_| "state key is not 32 bytes".to_owned())
}

/// `nonce (24 B) ‖ XChaCha20-Poly1305(state key, nonce, plaintext, aad)`. A random 192-bit
/// nonce cannot repeat in practice, so no counter has to survive between processes.
pub fn encrypt_state(plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let nonce: [u8; NONCE_LEN] = random();
    let sealed = state_cipher()?
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| "seal state: encryption failed".to_owned())?;
    Ok([nonce.as_slice(), &sealed].concat())
}

pub fn decrypt_state(ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let refused = || "state blob does not open: not sealed by this referee for this match".to_owned();
    if ciphertext.len() < NONCE_LEN {
        return Err(refused());
    }
    let (nonce, sealed) = ciphertext.split_at(NONCE_LEN);
    state_cipher()?
        .decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad })
        .map_err(|_| refused())
}

fn record_path(root: &Path, key: &str) -> PathBuf {
    root.join("storage").join(hex::encode(key))
}

/// Held while a write decides on and replaces a record. An OS advisory lock, so a process
/// that dies holding it releases it with its file handle.
fn storage_lock(root: &Path) -> Result<File, String> {
    let path = root.join("storage.lock");
    let f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    f.lock()
        .map_err(|e| format!("cannot lock {}: {e}", path.display()))?;
    Ok(f)
}

pub fn storage_get(key: &str) -> Result<Option<Vec<u8>>, String> {
    read_opt(&record_path(&dir()?, key)).map_err(|e| format!("storage get {key}: {e}"))
}

/// Takes the lock so it cannot land between a compare-and-swap's read and its write.
pub fn storage_set(key: &str, value: &[u8]) -> Result<(), String> {
    let root = dir()?;
    let _lock = storage_lock(&root)?;
    replace(&root, &record_path(&root, key), value).map_err(|e| format!("storage set {key}: {e}"))
}

/// Needs no lock: the link fails if any writer, locked or not, got there first.
pub fn storage_set_if_absent(key: &str, value: &[u8]) -> Result<bool, String> {
    let root = dir()?;
    create_if_absent(&root, &record_path(&root, key), value)
        .map_err(|e| format!("storage set_if_absent {key}: {e}"))
}

/// Compare-and-swap; `Ok(false)` when another run changed or removed the record first. The
/// compare and the rename happen under the storage lock, which every replacing write takes.
pub fn storage_replace(key: &str, expected: &[u8], value: &[u8]) -> Result<bool, String> {
    let root = dir()?;
    let path = record_path(&root, key);
    let _lock = storage_lock(&root)?;
    let current = read_opt(&path).map_err(|e| format!("storage set_if_equals {key}: {e}"))?;
    if current.as_deref() != Some(expected) {
        return Ok(false);
    }
    replace(&root, &path, value).map_err(|e| format!("storage set_if_equals {key}: {e}"))?;
    Ok(true)
}

/// The account named as the VRF sender, where the OutLayer worker puts the caller.
fn owner() -> Result<String, String> {
    let owner = std::env::var(OWNER_VAR)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_OWNER.to_owned());
    // The contract and the replay read the seed after the last ':'.
    if owner.contains(':') {
        return Err(format!("{OWNER_VAR} may not contain ':'"));
    }
    Ok(owner)
}

/// The OutLayer VRF's construction with a local key: `signature` = ed25519(vrf_sk, alpha),
/// alpha = `vrf:{request_id}:{sender}:{seed}`, where the request id is this call's id and the
/// sender is `TAIL_LOCAL_REFEREE_OWNER`.
pub fn vrf(seed: &str) -> Result<Vrf, String> {
    if seed.contains(':') {
        return Err("vrf: the seed may not contain ':'".into());
    }
    let alpha = format!("vrf:{}:{}:{seed}", uuid_string(&call_id()?), owner()?);
    let signature = signing_key(VRF_KEY)?.sign(alpha.as_bytes()).to_bytes();
    Ok(Vrf { alpha, signature })
}

/// Hex, as the OutLayer worker reports its VRF key.
pub fn vrf_pk() -> Result<String, String> {
    Ok(hex::encode(signing_key(VRF_KEY)?.verifying_key().to_bytes()))
}

/// Nanoseconds since this process first asked; the shared base of `now_ms` and the Handler
/// deadlines.
pub fn monotonic_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

/// Monotonic milliseconds, for timing inside the process.
pub fn now_ms() -> u64 {
    monotonic_ns() / 1_000_000
}

/// The machine's wall clock in Unix milliseconds. As on OutLayer, it only bounds how far ahead
/// of real time a caller may push the referee clock (`tick`).
pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
