use popular_agent_core::errors::AgentError;
use std::{net::SocketAddr, path::PathBuf, time::Duration};

pub struct Config {
    pub bind: SocketAddr,
    pub origin: String,
    pub authority: String,
    pub secure_cookie: bool,
    pub data: PathBuf,
    pub static_dir: PathBuf,
    pub master_key: PathBuf,
    pub admin_password: PathBuf,
    pub session_ttl: Duration,
}
impl Config {
    pub fn from_env() -> Result<Self, AgentError> {
        let bind = std::env::var("AGENT_WEB_BIND")
            .unwrap_or_else(|_| "127.0.0.1:1423".into())
            .parse()
            .map_err(|e| AgentError::caused("invalidSettings", e))?;
        let ttl = std::env::var("AGENT_SESSION_TTL_SECONDS")
            .unwrap_or_else(|_| "28800".into())
            .parse::<u64>()
            .map_err(|e| AgentError::caused("invalidSettings", e))?;
        if !(60..=86400).contains(&ttl) {
            return Err(AgentError::code("invalidSettings"));
        }
        let mut config = Self {
            bind,
            origin: std::env::var("AGENT_WEB_ORIGIN")
                .unwrap_or_else(|_| "http://127.0.0.1:1423".into()),
            authority: String::new(),
            secure_cookie: false,
            data: env_path("AGENT_DATA_DIR", "./.data/agent-web"),
            static_dir: env_path("AGENT_WEB_STATIC_DIR", "apps/helpers/agent/web/dist"),
            master_key: env_path("AGENT_MASTER_KEY_FILE", "./.data/agent-secrets/master.key"),
            admin_password: env_path(
                "AGENT_ADMIN_PASSWORD_FILE",
                "./.data/agent-secrets/admin-password",
            ),
            session_ttl: Duration::from_secs(ttl),
        };
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&mut self) -> Result<(), AgentError> {
        if !(60..=86400).contains(&self.session_ttl.as_secs()) {
            return Err(AgentError::code("invalidSettings"));
        }
        let url = url::Url::parse(&self.origin).map_err(|e| AgentError::caused("invalidUrl", e))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(AgentError::code("invalidUrl"));
        }
        self.origin = url.origin().ascii_serialization();
        self.authority = url[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
        self.secure_cookie = url.scheme() == "https";
        Ok(())
    }
}
fn env_path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| default.into())
}
