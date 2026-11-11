use base64::{engine::general_purpose::STANDARD, Engine};
use popular_agent_core::{credentials::CredentialStore, errors::AgentError, settings::Secrets};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    nonce: String,
    ciphertext: String,
}
pub struct FileCredentials {
    directory: PathBuf,
    key: aead::LessSafeKey,
}
impl FileCredentials {
    pub fn open(directory: &Path, key_file: &Path) -> Result<Self, AgentError> {
        let bytes = read_secret(key_file, 32)?;
        if bytes.len() != 32 {
            return Err(AgentError::code("credentialError"));
        }
        let key = aead::UnboundKey::new(&aead::AES_256_GCM, &bytes)
            .map_err(|e| AgentError::caused("cryptoError", e))?;
        private_directory(directory)?;
        let store = Self {
            directory: directory.into(),
            key: aead::LessSafeKey::new(key),
        };
        let sentinel = directory.join("key-check.json");
        if sentinel.exists() {
            let plain = store.decrypt("key-check", &read_secret(&sentinel, 65536)?)?;
            if plain != b"popular-agent-web-key-v1" {
                return Err(AgentError::code("credentialError"));
            }
        } else {
            // Never initialize a new key over an existing encrypted credential directory.
            if std::fs::read_dir(directory)?.next().is_some() {
                return Err(AgentError::code("credentialError"));
            }
            atomic(
                directory,
                "key-check.json",
                &store.encrypt("key-check", b"popular-agent-web-key-v1")?,
            )?;
        }
        Ok(store)
    }
    fn encrypt(&self, id: &str, plain: &[u8]) -> Result<Vec<u8>, AgentError> {
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|e| AgentError::caused("cryptoError", e))?;
        let mut bytes = plain.to_vec();
        let context = format!("popular-agent-web:v1:{id}");
        self.key
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(context.as_bytes()),
                &mut bytes,
            )
            .map_err(|e| AgentError::caused("cryptoError", e))?;
        Ok(serde_json::to_vec(&Envelope {
            version: 1,
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(bytes),
        })?)
    }
    fn decrypt(&self, id: &str, bytes: &[u8]) -> Result<Vec<u8>, AgentError> {
        let envelope: Envelope = serde_json::from_slice(bytes)?;
        if envelope.version != 1 {
            return Err(AgentError::code("credentialError"));
        }
        let nonce: [u8; 12] = STANDARD
            .decode(envelope.nonce)
            .map_err(|e| AgentError::caused("credentialError", e))?
            .try_into()
            .map_err(|_| AgentError::code("credentialError"))?;
        let mut data = STANDARD
            .decode(envelope.ciphertext)
            .map_err(|e| AgentError::caused("credentialError", e))?;
        let context = format!("popular-agent-web:v1:{id}");
        let plain = self
            .key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(context.as_bytes()),
                &mut data,
            )
            .map_err(|e| AgentError::caused("credentialError", e))?;
        Ok(plain.to_vec())
    }
    fn filename(id: &str) -> Result<String, AgentError> {
        uuid::Uuid::parse_str(id).map_err(|e| AgentError::caused("credentialError", e))?;
        Ok(format!("{id}.json"))
    }
}
impl CredentialStore for FileCredentials {
    fn read(&self, id: &str) -> Result<Secrets, AgentError> {
        let bytes = read_secret(&self.directory.join(Self::filename(id)?), 65536)?;
        Ok(serde_json::from_slice(&self.decrypt(id, &bytes)?)?)
    }
    fn write(&self, id: &str, secrets: &Secrets) -> Result<(), AgentError> {
        atomic(
            &self.directory,
            &Self::filename(id)?,
            &self.encrypt(id, &serde_json::to_vec(secrets)?)?,
        )
    }
    fn delete(&self, id: &str) -> Result<(), AgentError> {
        match std::fs::remove_file(self.directory.join(Self::filename(id)?)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
pub fn private_directory(directory: &Path) -> Result<(), AgentError> {
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn read_secret(path: &Path, max: usize) -> Result<Vec<u8>, AgentError> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take((max + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(AgentError::code("credentialError"));
    }
    Ok(bytes)
}
fn atomic(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), AgentError> {
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(directory.join(name))
        .map_err(|e| AgentError::caused("storageError", e.error))?;
    std::fs::File::open(directory)?.sync_all()?;
    Ok(())
}
pub fn initialize_secrets(directory: &Path) -> Result<(), AgentError> {
    private_directory(directory)?;
    if std::fs::read_dir(directory)?.next().is_some() {
        return Err(AgentError::code("credentialError"));
    }
    let random = SystemRandom::new();
    let mut key = [0; 32];
    let mut password = [0; 32];
    random
        .fill(&mut key)
        .map_err(|e| AgentError::caused("cryptoError", e))?;
    random
        .fill(&mut password)
        .map_err(|e| AgentError::caused("cryptoError", e))?;
    for (name, bytes) in [
        ("master.key", key.to_vec()),
        ("admin-password", STANDARD.encode(password).into_bytes()),
    ] {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(directory.join(name))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    Ok(())
}

// Publish a complete secret without ever truncating an existing file.
fn create_secret(path: &Path, bytes: &[u8]) -> Result<(), AgentError> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let write = || -> Result<(), std::io::Error> {
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        match file.persist_noclobber(path) {
            Ok(_) => {
                std::fs::File::open(parent)?.sync_all()?;
                Ok(())
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error.error),
        }
    };
    write().map_err(|error| AgentError::caused("managementSecretInitializationFailed", error))
}
fn missing(path: &Path) -> Result<bool, AgentError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}
pub fn ensure_master_key(data: &Path, path: &Path) -> Result<(), AgentError> {
    if !missing(path)? {
        return Ok(());
    }
    for entry in std::fs::read_dir(data)? {
        if entry?.file_name() != ".agent.lock" {
            return Err(AgentError::code("managementMasterKeyMissing"));
        }
    }
    let mut key = [0; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|e| AgentError::caused("cryptoError", e))?;
    let result = create_secret(path, &key);
    key.fill(0);
    result
}
pub fn ensure_admin_password(path: &Path) -> Result<(), AgentError> {
    if !missing(path)? {
        return Ok(());
    }
    let mut random = [0; 32];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|e| AgentError::caused("cryptoError", e))?;
    let mut password = STANDARD.encode(random).into_bytes();
    random.fill(0);
    let result = create_secret(path, &password);
    password.fill(0);
    result
}
// Resolve even an absent secret before initialization, so secrets cannot be
// generated under the data directory or the publicly served static directory.
pub fn secret_destination(path: &Path) -> Result<std::path::PathBuf, AgentError> {
    if !missing(path)? {
        return Ok(std::fs::canonicalize(path)?);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.exists() {
        private_directory(parent)?;
    }
    Ok(std::fs::canonicalize(parent)?.join(
        path.file_name()
            .ok_or_else(|| AgentError::code("invalidSettings"))?,
    ))
}
