use crate::{errors::AgentError, settings::Secrets};

pub trait CredentialStore {
    fn read(&self, id: &str) -> Result<Secrets, AgentError>;
    fn write(&self, id: &str, secrets: &Secrets) -> Result<(), AgentError>;
    fn delete(&self, id: &str) -> Result<(), AgentError>;
}

/// Sanitized platform classification, retaining the original source without formatting it.
#[derive(Clone, Copy, Debug)]
pub enum CredentialFailureKind {
    Missing,
    AccessDenied,
    Encoding,
    TooLong,
    Platform,
}
impl CredentialFailureKind {
    pub fn category(self) -> &'static str {
        match self {
            Self::Missing => "credential:missing",
            Self::AccessDenied => "credential:access-denied",
            Self::Encoding => "credential:encoding",
            Self::TooLong => "credential:platform-length-limit",
            Self::Platform => "credential:platform-error",
        }
    }
}
pub struct CredentialFailure {
    pub kind: CredentialFailureKind,
    source: Box<dyn std::error::Error + Send + Sync>,
}
impl CredentialFailure {
    pub fn new(
        kind: CredentialFailureKind,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            kind,
            source: Box::new(source),
        }
    }
}
impl std::fmt::Display for CredentialFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.kind.category())
    }
}
impl std::error::Error for CredentialFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

impl std::fmt::Debug for CredentialFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.kind.category())
    }
}
