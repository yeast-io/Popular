//! Gateway Socket v1. Private keys never leave the system credential store.
use crate::errors::AgentError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::{
    aead, digest,
    rand::SystemRandom,
    signature::{self, KeyPair},
};
use rsa::{
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
    traits::PublicKeyParts,
    Oaep, RsaPrivateKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant, SystemTime};

pub const MAX_INTEGER: u64 = 9_007_199_254_740_991;
pub fn invalid() -> AgentError {
    AgentError::code("invalidCommand")
}
pub fn encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}
pub fn decode(text: &str) -> Result<Vec<u8>, AgentError> {
    B64.decode(text).map_err(|_| invalid())
}
pub fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn positive(n: u64) -> bool {
    n > 0 && n <= MAX_INTEGER
}
pub fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, AgentError> {
    serde_json::from_value(v.clone()).map_err(|e| AgentError::caused("invalidResponse", e))
}
fn crypto<E: std::error::Error + Send + Sync + 'static>(error: E) -> AgentError {
    AgentError::caused("cryptoError", error)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceKeys {
    signing: String,
    encryption: String,
}
impl DeviceKeys {
    pub fn generate() -> Result<Self, AgentError> {
        let signing = signature::Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| AgentError::code("cryptoError"))?;
        let encryption = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)
            .map_err(crypto)?
            .to_pkcs8_der()
            .map_err(crypto)?;
        Ok(Self {
            signing: encode(signing.as_ref()),
            encryption: encode(encryption.as_bytes()),
        })
    }
    fn signer(&self) -> Result<signature::Ed25519KeyPair, AgentError> {
        signature::Ed25519KeyPair::from_pkcs8(&decode(&self.signing)?)
            .map_err(|_| AgentError::code("cryptoError"))
    }
    pub fn public(&self) -> Result<Value, AgentError> {
        let rsa = RsaPrivateKey::from_pkcs8_der(&decode(&self.encryption)?).map_err(crypto)?;
        Ok(
            json!({"signingKey":{"kty":"OKP","crv":"Ed25519","x":encode(self.signer()?.public_key().as_ref())},
            "encryptionKey":{"kty":"RSA","n":encode(&rsa.n().to_bytes_be()),"e":"AQAB"}}),
        )
    }
    pub fn proof(&self, challenge: &str) -> Result<String, AgentError> {
        let input = format!(
            "{}.{}",
            encode(br#"{"alg":"EdDSA"}"#),
            encode(challenge.as_bytes())
        );
        Ok(format!(
            "{input}.{}",
            encode(self.signer()?.sign(input.as_bytes()).as_ref())
        ))
    }
    pub fn decrypt(&self, compact: &str) -> Result<Value, AgentError> {
        let parts: Vec<_> = compact.split('.').collect();
        if parts.len() != 5 || compact.len() > 60000 {
            return Err(invalid());
        }
        let header: Value = serde_json::from_slice(&decode(parts[0])?).map_err(|_| invalid())?;
        if header != json!({"alg":"RSA-OAEP-256","enc":"A256GCM","typ":"popular-gateway-v1"}) {
            return Err(invalid());
        }
        let rsa = RsaPrivateKey::from_pkcs8_der(&decode(&self.encryption)?).map_err(crypto)?;
        let cek = rsa
            .decrypt_blinded(
                &mut rand::rngs::OsRng,
                Oaep::new::<sha2::Sha256>(),
                &decode(parts[1])?,
            )
            .map_err(|_| invalid())?;
        if cek.len() != 32 {
            return Err(invalid());
        }
        let nonce: [u8; 12] = decode(parts[2])?.try_into().map_err(|_| invalid())?;
        let mut bytes = decode(parts[3])?;
        let tag = decode(parts[4])?;
        if tag.len() != 16 {
            return Err(invalid());
        }
        bytes.extend(tag);
        let key = aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::AES_256_GCM, &cek).map_err(|_| invalid())?,
        );
        let plain = key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(parts[0].as_bytes()),
                &mut bytes,
            )
            .map_err(|_| invalid())?;
        serde_json::from_slice(plain).map_err(|_| invalid())
    }
}
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("JSON key"),
                        canonical(&m[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => v.to_string(),
    }
}
pub fn fingerprint(v: &Value) -> String {
    digest::digest(&digest::SHA256, canonical(v).as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedHeader {
    alg: String,
    kid: String,
    typ: String,
}
pub fn verify(compact: &str, jwks: &Value) -> Result<Value, AgentError> {
    let parts: Vec<_> = compact.split('.').collect();
    if parts.len() != 3 || compact.len() > 60000 {
        return Err(invalid());
    }
    let header: SignedHeader = serde_json::from_slice(&decode(parts[0])?).map_err(|_| invalid())?;
    if header.alg != "EdDSA" || header.typ != "popular-gateway-v1" || !id(&header.kid) {
        return Err(invalid());
    }
    let keys = jwks["keys"]
        .as_array()
        .filter(|keys| !keys.is_empty() && keys.len() <= 32)
        .ok_or_else(invalid)?;
    let matching: Vec<_> = keys.iter().filter(|k| k["kid"] == header.kid).collect();
    if matching.len() != 1 {
        return Err(invalid());
    }
    let key = matching[0];
    if key["kty"] != "OKP"
        || key["crv"] != "Ed25519"
        || key["alg"] != "EdDSA"
        || key["use"] != "sig"
        || key.get("d").is_some()
    {
        return Err(invalid());
    }
    signature::UnparsedPublicKey::new(
        &signature::ED25519,
        decode(key["x"].as_str().ok_or_else(invalid)?)?,
    )
    .verify(
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
        &decode(parts[2])?,
    )
    .map_err(|_| invalid())?;
    serde_json::from_slice(&decode(parts[1])?).map_err(|_| invalid())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wire {
    pub protocol_version: u8,
    pub command: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub payload: Value,
}
pub fn message(command: &str, payload: Value, correlation: Option<String>) -> Wire {
    Wire {
        protocol_version: 1,
        command: command.into(),
        message_id: uuid::Uuid::new_v4().to_string(),
        reply_to: None,
        correlation_id: correlation,
        payload,
    }
}
pub fn wire(text: &str) -> Result<Wire, AgentError> {
    if text.len() > 65536 {
        return Err(invalid());
    }
    let wire: Wire =
        serde_json::from_str(text).map_err(|e| AgentError::caused("invalidResponse", e))?;
    if wire.protocol_version != 1
        || !id(&wire.message_id)
        || wire.reply_to.as_ref().is_some_and(|s| !id(s))
        || wire.correlation_id.as_ref().is_some_and(|s| !id(s))
        || !wire.command.starts_with("__")
        || !wire.command.ends_with("__")
        || wire.command.len() < 5
        || !wire.command[2..wire.command.len() - 2]
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c == b'_')
    {
        return Err(invalid());
    }
    Ok(wire)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub owner_id: String,
    pub device_id: String,
    pub auth_version: u64,
    pub device_version: u64,
    pub session_id: String,
    pub instance_id: String,
}
impl Context {
    pub fn valid(&self) -> bool {
        [
            &self.owner_id,
            &self.device_id,
            &self.session_id,
            &self.instance_id,
        ]
        .iter()
        .all(|s| id(s))
            && positive(self.auth_version)
            && positive(self.device_version)
    }
    pub fn check(&self, v: &Value) -> Result<(), AgentError> {
        if v["ownerId"] != self.owner_id
            || v["deviceId"] != self.device_id
            || v["authVersion"] != self.auth_version
            || v["deviceVersion"] != self.device_version
            || v["sessionId"] != self.session_id
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn same_authority(&self, other: &Self) -> bool {
        self.owner_id == other.owner_id
            && self.device_id == other.device_id
            && self.auth_version == other.auth_version
            && self.device_version == other.device_version
    }
}
pub struct Clock {
    pub server_ms: u64,
    pub anchor: Instant,
    pub wall_anchor: SystemTime,
}
impl Clock {
    pub fn now(&self) -> u64 {
        let elapsed = self.anchor.elapsed();
        // Some OS monotonic clocks exclude sleep. Wall time is only a fail-closed
        // suspension/clock-jump detector; it never extends server authorization.
        let Ok(wall) = self.wall_anchor.elapsed() else {
            return MAX_INTEGER;
        };
        if wall.abs_diff(elapsed) > Duration::from_secs(5) {
            return MAX_INTEGER;
        }
        self.server_ms.saturating_add(elapsed.as_millis() as u64)
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub protocol_version: u8,
    pub command: String,
    pub message_id: String,
    pub command_id: String,
    pub download_id: String,
    pub owner_id: String,
    pub device_id: String,
    pub auth_version: u64,
    pub device_version: u64,
    pub session_id: String,
    pub source: String,
    pub resource_id: String,
    pub correlation_id: String,
    pub expires_at: u64,
    pub torrent_url: String,
    #[serde(default, deserialize_with = "optional_integer")]
    pub queue_expires_at: Option<u64>,
    #[serde(default, deserialize_with = "optional_integer")]
    pub retry_attempt: Option<u64>,
    pub torrent_hash: String,
}
fn optional_integer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    u64::deserialize(deserializer).map(Some)
}
impl Command {
    pub fn valid_deadlines(&self, now: u64) -> bool {
        positive(self.expires_at)
            && self.expires_at > now
            && self.expires_at <= now.saturating_add(60_000)
            && self.retry_attempt.is_none_or(|n| n <= MAX_INTEGER)
            && self
                .queue_expires_at
                .is_none_or(|n| positive(n) && self.expires_at <= n)
    }
}
pub fn command(
    wire: &Wire,
    keys: &DeviceKeys,
    jwks: &Value,
    context: &Context,
    now: u64,
) -> Result<Command, AgentError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Envelope {
        protocol_version: u8,
        command: String,
        jwe: String,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Delivery {
        envelope: String,
    }
    let d: Delivery = parse(&wire.payload)?;
    let wrapper: Envelope = parse(&verify(&d.envelope, jwks)?)?;
    if wrapper.protocol_version != 1 || wrapper.command != "__add_download__" {
        return Err(invalid());
    }
    let plain = keys.decrypt(&wrapper.jwe)?;
    context.check(&plain)?;
    let command: Command = parse(&plain)?;
    let url = url::Url::parse(&command.torrent_url).map_err(|_| invalid())?;
    let host = url.host_str().unwrap_or("");
    if command.protocol_version != 1
        || command.command != "__add_download__"
        || command.message_id != wire.message_id
        || Some(command.correlation_id.as_str()) != wire.correlation_id.as_deref()
        || command.expires_at <= now
        || !command.valid_deadlines(now)
        || ![
            &command.command_id,
            &command.download_id,
            &command.resource_id,
            &command.correlation_id,
        ]
        .iter()
        .all(|s| id(s))
        || !matches!(command.source.as_str(), "mteam" | "hdarea")
        || !matches!(command.torrent_hash.len(), 40 | 64)
        || !command
            .torrent_hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || command.torrent_url.len() > 8192
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || host == "localhost"
        || !host.contains('.')
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.ends_with(".local")
    {
        return Err(invalid());
    }
    Ok(command)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub protocol_version: u8,
    pub command: String,
    pub command_id: String,
    pub download_id: String,
    pub owner_id: String,
    pub device_id: String,
    pub auth_version: u64,
    pub device_version: u64,
    pub session_id: String,
    pub execution_id: String,
    pub expires_at: u64,
    pub correlation_id: String,
    pub torrent_hash: String,
    pub downloader: DownloaderTarget,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloaderTarget {
    pub downloader_type: crate::settings::Provider,
    pub instance_id: String,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sleep_or_wall_clock_changes_can_only_expire_authorization() {
        let mut clock = Clock {
            server_ms: 1000,
            anchor: Instant::now(),
            wall_anchor: SystemTime::now() - Duration::from_secs(60),
        };
        assert_eq!(clock.now(), MAX_INTEGER);
        clock.wall_anchor = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(clock.now(), MAX_INTEGER);
        clock.wall_anchor = SystemTime::now();
        assert!(clock.now() >= 1000 && clock.now() < 1100);
    }
    #[test]
    fn validates_wire_and_canonical_json() {
        assert_eq!(
            canonical(&json!({"z":1,"a":{"b":2,"a":3}})),
            r#"{"a":{"a":3,"b":2},"z":1}"#
        );
        assert!(id("command-1"));
        assert!(!id("a.b"));
        let mut wire = serde_json::to_value(message("__agent_status__", json!({}), None)).unwrap();
        assert!(super::wire(&wire.to_string()).is_ok());
        wire["extra"] = json!(1);
        assert!(super::wire(&wire.to_string()).is_err());
    }
}
