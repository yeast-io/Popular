use crate::settings::SecretChange;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Site {
    Mteam,
    Hdarea,
    Hdwing,
}
impl Site {
    pub const ALL: [Self; 3] = [Self::Mteam, Self::Hdarea, Self::Hdwing];
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Mteam => "mteam",
            Self::Hdarea => "hdarea",
            Self::Hdwing => "hdwing",
        }
    }
    pub fn index(self) -> usize {
        match self {
            Self::Mteam => 0,
            Self::Hdarea => 1,
            Self::Hdwing => 2,
        }
    }
    pub fn base(self) -> &'static str {
        match self {
            Self::Mteam => "https://api.m-team.cc",
            Self::Hdarea => "https://hdarea.club",
            Self::Hdwing => "https://hdwing.org",
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureRequest {
    pub site: Site,
    pub base_url: String,
    pub credential: SecretChange,
    #[serde(default = "super::keep_secret")]
    pub passkey: SecretChange,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteRequest {
    pub site: Site,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnabledRequest {
    pub site: Site,
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    ConfiguredValid,
    ConfiguredInvalid,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredSite {
    pub site: Site,
    pub base_url: String,
    pub credential_id: String,
    pub enabled: bool,
    pub status: Status,
    pub verified_at: u64,
    pub last_error: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StoredSites {
    pub sites: Vec<StoredSite>,
    #[serde(default)]
    pub pending_cleanup: Vec<PendingCredential>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PendingCredential {
    pub site: Site,
    pub credential_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SiteSecrets {
    pub site: Site,
    pub base_url: String,
    pub credential: String,
    #[serde(default)]
    pub passkey: String,
    pub external_user_id: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSnapshot {
    pub site: Site,
    pub base_url: String,
    pub enabled: bool,
    pub status: &'static str,
    pub has_credential: bool,
    pub has_passkey: bool,
    pub requires_passkey: bool,
    pub verified_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub(crate) enum TorrentSource {
    Url(String),
    Metainfo(String),
}
impl From<String> for TorrentSource {
    fn from(value: String) -> Self {
        Self::Url(value)
    }
}
