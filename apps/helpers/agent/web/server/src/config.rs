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
    pub login: Option<(String, String)>,
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
            login: login_from_env()?,
        };
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&mut self) -> Result<(), AgentError> {
        if let Some((username, password)) = &self.login {
            if username.is_empty()
                || username.len() > 128
                || username.trim() != username
                || username.chars().any(char::is_control)
                || !(8..=4096).contains(&password.len())
            {
                return Err(AgentError::code("managementLoginInvalid"));
            }
        }
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

fn login_from_env() -> Result<Option<(String, String)>, AgentError> {
    let read = |name| match std::env::var(name) {
        Ok(value) => Ok(value),
        Err(std::env::VarError::NotPresent) => Ok(String::new()),
        Err(_) => Err(AgentError::code("managementLoginInvalid")),
    };
    let username = read("WEB_LOGIN_USER")?;
    let password = read("WEB_LOGIN_PASSWORD")?;
    if username.is_empty() && password.is_empty() {
        Ok(None)
    } else {
        Ok(Some((username, password)))
    }
}
