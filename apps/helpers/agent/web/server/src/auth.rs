use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use popular_agent_core::errors::AgentError;
use ring::{
    digest, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    collections::HashMap,
    net::IpAddr,
    num::NonZeroU32,
    sync::Mutex,
    time::{Duration, Instant},
};

const ITERATIONS: u32 = 600_000;
pub struct PasswordVerifier {
    salt: [u8; 32],
    digest: [u8; 32],
}
impl PasswordVerifier {
    pub fn new(password: &[u8]) -> Result<Self, AgentError> {
        if !(8..=4096).contains(&password.len()) {
            return Err(AgentError::code("managementPasswordInvalid"));
        }
        let mut salt = [0; 32];
        let mut digest = [0; 32];
        SystemRandom::new()
            .fill(&mut salt)
            .map_err(|e| AgentError::caused("cryptoError", e))?;
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA256,
            NonZeroU32::new(ITERATIONS).unwrap(),
            &salt,
            password,
            &mut digest,
        );
        Ok(Self { salt, digest })
    }
    pub fn verify(&self, password: &[u8]) -> bool {
        (8..=4096).contains(&password.len())
            && pbkdf2::verify(
                pbkdf2::PBKDF2_HMAC_SHA256,
                NonZeroU32::new(ITERATIONS).unwrap(),
                &self.salt,
                password,
                &self.digest,
            )
            .is_ok()
    }
}
#[derive(Clone)]
pub struct Session {
    pub csrf: String,
    pub expires: Instant,
}
struct Rate {
    started: Instant,
    count: u32,
}
pub struct Auth {
    sessions: Mutex<HashMap<[u8; 32], Session>>,
    rates: Mutex<HashMap<Option<IpAddr>, Rate>>,
    pub verifier: PasswordVerifier,
    pub ttl: Duration,
    pub username: Option<String>,
}
fn hash(token: &str) -> [u8; 32] {
    digest::digest(&digest::SHA256, token.as_bytes())
        .as_ref()
        .try_into()
        .unwrap()
}
fn random_token() -> Result<String, AgentError> {
    let mut bytes = [0; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|e| AgentError::caused("cryptoError", e))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
impl Auth {
    pub fn new(password: &[u8], ttl: Duration) -> Result<Self, AgentError> {
        Ok(Self {
            sessions: Default::default(),
            rates: Default::default(),
            verifier: PasswordVerifier::new(password)?,
            ttl,
            username: None,
        })
    }
    pub fn verify(&self, username: Option<&str>, password: &[u8]) -> bool {
        // Always perform password verification, including when the username is wrong.
        let password_valid = self.verifier.verify(password);
        let username_valid = self
            .username
            .as_deref()
            .is_none_or(|expected| Some(expected) == username);
        password_valid && username_valid
    }
    pub fn allow_login(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut rates = self.rates.lock().unwrap_or_else(|e| e.into_inner());
        rates.retain(|_, r| now.duration_since(r.started) < Duration::from_secs(60));
        if rates.len() >= 1024 && !rates.contains_key(&Some(ip)) {
            return false;
        }
        for (key, limit) in [(None, 32), (Some(ip), 8)] {
            let rate = rates.entry(key).or_insert(Rate {
                started: now,
                count: 0,
            });
            rate.count += 1;
            if rate.count > limit {
                return false;
            }
        }
        true
    }
    pub fn create(&self) -> Result<(String, Session), AgentError> {
        let token = random_token()?;
        let session = Session {
            csrf: random_token()?,
            expires: Instant::now() + self.ttl,
        };
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, s| s.expires > Instant::now());
        if sessions.len() >= 32 {
            return Err(AgentError::code("managementRateLimited"));
        }
        sessions.insert(hash(&token), session.clone());
        Ok((token, session))
    }
    pub fn session(&self, token: &str) -> Option<Session> {
        if token.len() != 43 {
            return None;
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let key = hash(token);
        let session = sessions.get(&key)?.clone();
        if session.expires <= Instant::now() {
            sessions.remove(&key);
            None
        } else {
            Some(session)
        }
    }
    pub fn remove(&self, token: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&hash(token));
    }
}
