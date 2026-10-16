//! Password authentication extension (0x02).
//!
//! Flow: the server lists the extension in its INFO with a [required u8]
//! payload. The client replies with
//! [user_len u8][user][password]. On mismatch the server must send
//! CLOSE(0xc0) and drop the websocket.

use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// #198: PBKDF2-HMAC-SHA256 work factor (OWASP 2023 minimum for this
/// KDF). A single fast SHA-256 let an offline attacker try billions
/// of candidates per GPU-second against a leaked store; the KDF moves
/// that cost onto every guess.
const PBKDF2_ROUNDS: u32 = 600_000;
/// #198: fresh random salt per stored user.
const SALT_LEN: usize = 16;

/// Server-side password store.
///
/// Passwords are stored as PBKDF2-HMAC-SHA256 digests over a random
/// per-user salt (#198). Verification walks every entry so username
/// enumeration does not leak through timing.
pub struct PasswordAuth {
    required: bool,
    /// username -> (salt, PBKDF2 digest)
    users: Vec<(String, Vec<u8>, [u8; 32])>,
}

impl PasswordAuth {
    /// Create with a set of (username, password) pairs; derives each
    /// store entry now.
    pub fn new(required: bool, users: Vec<(String, String)>) -> Self {
        Self {
            required,
            users: users
                .into_iter()
                .map(|(u, p)| {
                    let mut salt = vec![0u8; SALT_LEN];
                    rand::thread_rng().fill_bytes(&mut salt);
                    let digest = Self::hash(&salt, &p);
                    (u, salt, digest)
                })
                .collect(),
        }
    }

    pub fn required(&self) -> bool {
        self.required
    }

    /// Salted PBKDF2 digest for storage.
    fn hash(salt: &[u8], password: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ROUNDS, &mut out);
        out
    }

    /// Verify a client INFO payload:
    /// [user_len u8][user bytes][password bytes (rest)].
    pub fn verify_payload(&self, payload: &[u8]) -> bool {
        let Some(msg) = wisp_core::extension::password_auth_client_decode(payload) else {
            return false;
        };
        self.verify(&msg.0, &msg.1)
    }

    /// Constant-time verification against the store.
    pub fn verify(&self, username: &str, password: &str) -> bool {
        // Compare against every entry to avoid username-enumeration timing.
        let mut ok = false;
        for (user, salt, stored) in &self.users {
            let candidate = Self::hash(salt, password);
            let user_match = user.as_bytes().ct_eq(username.as_bytes());
            let hash_match = candidate.ct_eq(stored);
            // Only when both match do we set ok; timing stays uniform.
            if bool::from(user_match) && bool::from(hash_match) {
                ok = true;
            }
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_correct_credentials() {
        let auth = PasswordAuth::new(true, vec![("ada".into(), "hunter2".into())]);
        assert!(auth.verify("ada", "hunter2"));
        assert!(!auth.verify("ada", "wrong"));
        assert!(!auth.verify("eve", "hunter2"));
    }

    #[test]
    fn verifies_wire_payload() {
        let auth = PasswordAuth::new(true, vec![("ada".into(), "pw".into())]);
        let good = wisp_core::extension::password_auth_client("ada", "pw").unwrap();
        assert!(auth.verify_payload(&good));
        let bad = wisp_core::extension::password_auth_client("ada", "nope").unwrap();
        assert!(!auth.verify_payload(&bad));
        assert!(!auth.verify_payload(&[99, 1, 2])); // malformed
    }

    /// #198: each construction derives a fresh random salt, so two
    /// stores built from identical credentials hold different
    /// digests; verification still works per-store.
    #[test]
    fn fresh_salt_per_construction() {
        let a = PasswordAuth::new(true, vec![("ada".into(), "hunter2".into())]);
        let b = PasswordAuth::new(true, vec![("ada".into(), "hunter2".into())]);
        assert!(a.verify("ada", "hunter2"));
        assert!(b.verify("ada", "hunter2"));
        // Salt is the store's own; cross-store digests differ (salt
        // differs, PBKDF2 output follows). Observable only via verify
        // against a swapped salt, so assert the positive path only.
        let (user, salt, digest) = &a.users[0];
        assert_eq!(user, "ada");
        assert_eq!(salt.len(), SALT_LEN);
        let recomputed = PasswordAuth::hash(salt, "hunter2");
        assert_eq!(&recomputed, digest);
        let other_salt = &b.users[0].1;
        assert_ne!(salt, other_salt, "salt must be random per store");
    }
}
