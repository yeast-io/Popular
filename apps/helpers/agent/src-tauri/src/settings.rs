use serde::{Deserialize, Serialize};

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Qbittorrent,
    Transmission,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub locale: String,
    pub gateway_url: String,
    pub provider: Provider,
    pub downloader_url: String,
    pub username: String,
    #[serde(default = "enabled")]
    pub autostart: bool,
    #[serde(default = "enabled")]
    pub gateway_enabled: bool,
    // Missing in older installations, which already treated their target as configured.
    #[serde(default = "enabled")]
    pub downloader_configured: bool,
}
fn enabled() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            locale: "en-US".into(),
            gateway_url: String::new(),
            provider: Provider::default(),
            downloader_url: "http://127.0.0.1:8080".into(),
            username: String::new(),
            autostart: true,
            gateway_enabled: true,
            downloader_configured: false,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredSettings {
    pub settings: Settings,
    pub credential_id: Option<String>,
}

// The secret bundle exists only in native memory and the OS credential store.
#[derive(Default, Serialize, Deserialize)]
pub struct Secrets {
    pub api_key: String,
    pub password: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    content = "value",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub enum SecretChange {
    Keep,
    Set(String),
    Clear,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    pub settings: Settings,
    pub api_key: SecretChange,
    pub password: SecretChange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayRequest {
    pub gateway_url: String,
    pub locale: String,
    pub api_key: SecretChange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestRequest {
    pub provider: Provider,
    pub downloader_url: String,
    pub username: String,
    pub password: SecretChange,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: Settings,
    pub has_api_key: bool,
    pub has_password: bool,
}

fn parse_endpoint(raw: &str, gateway: bool) -> Result<url::Url, crate::errors::AgentError> {
    let url = url::Url::parse(raw).map_err(|_| crate::errors::AgentError::code("invalidUrl"))?;
    if raw.len() > 2048
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(matches!(url.scheme(), "http" | "https")
            || gateway && matches!(url.scheme(), "ws" | "wss"))
    {
        return Err(crate::errors::AgentError::code("invalidUrl"));
    }
    Ok(url)
}
pub fn endpoint(raw: &str, gateway: bool) -> Result<url::Url, crate::errors::AgentError> {
    let url = parse_endpoint(raw, gateway)?;
    if gateway
        && matches!(url.scheme(), "http" | "ws")
        && std::env::var("HELPER_ALLOW_INSECURE_DEV").as_deref() != Ok("true")
    {
        return Err(crate::errors::AgentError::code("insecureGateway"));
    }
    Ok(url)
}

// Normalize only at a connection/save boundary; never rewrite persisted task identities.
pub fn downloader_endpoint(
    raw: &str,
    provider: &Provider,
) -> Result<url::Url, crate::errors::AgentError> {
    let raw = raw.trim();
    let address = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let mut url = endpoint(&address, false)?;
    let authority = address
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    let explicit_port = authority
        .rsplit_once(':')
        .is_some_and(|(_, port)| !port.is_empty() && port.bytes().all(|v| v.is_ascii_digit()));
    if !explicit_port {
        url.set_port(Some(match provider {
            Provider::Qbittorrent => 8080,
            Provider::Transmission => 9091,
        }))
        .map_err(|_| crate::errors::AgentError::code("invalidUrl"))?;
    }
    if *provider == Provider::Transmission && url.path() == "/" {
        url.set_path("/transmission/rpc");
    }
    Ok(url)
}

pub fn downloader_url(raw: &str, provider: &Provider) -> Result<String, crate::errors::AgentError> {
    let url = downloader_endpoint(raw, provider)?;
    let mut normalized = url.to_string();
    // URL serialization drops :80/:443. Retain an explicit standard port in stored settings
    // so a later connection cannot reinterpret it as the downloader's default port.
    let authority = raw
        .trim()
        .split("://")
        .last()
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    if url.port().is_none() {
        if let Some((_, port)) = authority.rsplit_once(':') {
            if !port.is_empty() && port.bytes().all(|v| v.is_ascii_digit()) {
                normalized.insert_str(url[..url::Position::AfterHost].len(), &format!(":{port}"));
            }
        }
    }
    Ok(normalized)
}

pub fn validate_stored(settings: &Settings) -> Result<(), crate::errors::AgentError> {
    if !matches!(settings.locale.as_str(), "en-US" | "zh-CN") || settings.username.len() > 512 {
        return Err(crate::errors::AgentError::code("invalidSettings"));
    }
    if !settings.gateway_url.is_empty() {
        parse_endpoint(&settings.gateway_url, true)?;
    }
    if settings.downloader_configured || !settings.downloader_url.is_empty() {
        parse_endpoint(&settings.downloader_url, false)?;
    }
    Ok(())
}

pub fn normalize(mut settings: Settings) -> Result<Settings, crate::errors::AgentError> {
    if !matches!(settings.locale.as_str(), "en-US" | "zh-CN") || settings.username.len() > 512 {
        return Err(crate::errors::AgentError::code("invalidSettings"));
    }
    settings.gateway_url = if settings.gateway_url.trim().is_empty() {
        String::new()
    } else {
        endpoint(settings.gateway_url.trim(), true)?.to_string()
    };
    if settings.downloader_configured || !settings.downloader_url.is_empty() {
        settings.downloader_url = downloader_url(&settings.downloader_url, &settings.provider)?;
    }
    Ok(settings)
}

pub fn same_downloader(a: &Settings, b: &Settings) -> bool {
    a.downloader_configured == b.downloader_configured
        && a.provider == b.provider
        && a.username == b.username
        && match (
            downloader_endpoint(&a.downloader_url, &a.provider),
            downloader_endpoint(&b.downloader_url, &b.provider),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => a.downloader_url == b.downloader_url,
        }
}

pub fn resolve_secret(
    change: &SecretChange,
    previous: &str,
    same_target: bool,
) -> Result<String, crate::errors::AgentError> {
    match change {
        SecretChange::Keep if !same_target && !previous.is_empty() => {
            Err(crate::errors::AgentError::code("targetChanged"))
        }
        SecretChange::Keep => Ok(previous.into()),
        SecretChange::Clear => Ok(String::new()),
        SecretChange::Set(value) if !value.is_empty() && value.len() <= 4096 => Ok(value.clone()),
        _ => Err(crate::errors::AgentError::code("invalidSecret")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_preserves_existing_connections_and_fresh_install_is_unconfigured() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("gatewayEnabled");
        old.as_object_mut().unwrap().remove("downloaderConfigured");
        let restored: Settings = serde_json::from_value(old).unwrap();
        assert!(restored.gateway_enabled && restored.downloader_configured);
        assert!(!Settings::default().downloader_configured);
    }
    #[test]
    fn rejects_embedded_secrets_and_non_http_downloader() {
        for url in [
            "http://u:p@localhost",
            "http://localhost/?key=secret",
            "http://localhost/#secret",
            "file:///tmp/a",
            "ws://localhost",
        ] {
            assert!(endpoint(url, false).is_err());
        }
        assert!(endpoint("http://[::1]:9091/transmission/rpc", false).is_ok());
        assert!(endpoint("wss://gateway.example/helpers", true).is_ok());
    }
    #[test]
    fn fills_downloader_defaults_and_preserves_explicit_routes_and_ports() {
        for (raw, provider, expected) in [
            (
                "127.0.0.1",
                Provider::Transmission,
                "http://127.0.0.1:9091/transmission/rpc",
            ),
            (
                "http://127.0.0.1:9091/",
                Provider::Transmission,
                "http://127.0.0.1:9091/transmission/rpc",
            ),
            (
                "https://localhost",
                Provider::Transmission,
                "https://localhost:9091/transmission/rpc",
            ),
            (
                "localhost:1234/custom/rpc",
                Provider::Transmission,
                "http://localhost:1234/custom/rpc",
            ),
            (
                "http://localhost:9091/transmission/rpc",
                Provider::Transmission,
                "http://localhost:9091/transmission/rpc",
            ),
            (
                "[::1]",
                Provider::Transmission,
                "http://[::1]:9091/transmission/rpc",
            ),
            ("127.0.0.1", Provider::Qbittorrent, "http://127.0.0.1:8080/"),
            (
                "192.168.1.5",
                Provider::Transmission,
                "http://192.168.1.5:9091/transmission/rpc",
            ),
            ("10.0.0.20", Provider::Qbittorrent, "http://10.0.0.20:8080/"),
            (
                "172.16.0.10:1234",
                Provider::Transmission,
                "http://172.16.0.10:1234/transmission/rpc",
            ),
            (
                "nas.local",
                Provider::Transmission,
                "http://nas.local:9091/transmission/rpc",
            ),
            (
                "https://nas.home:443/custom/rpc",
                Provider::Transmission,
                "https://nas.home:443/custom/rpc",
            ),
            (
                "[fd00::5]",
                Provider::Transmission,
                "http://[fd00::5]:9091/transmission/rpc",
            ),
            (
                "https://localhost:443/proxy",
                Provider::Qbittorrent,
                "https://localhost:443/proxy",
            ),
            (
                "http://localhost:80/",
                Provider::Transmission,
                "http://localhost:80/transmission/rpc",
            ),
        ] {
            let actual = downloader_url(raw, &provider).unwrap();
            assert_eq!(actual, expected);
            assert_eq!(downloader_url(&actual, &provider).unwrap(), actual);
        }
        for raw in [
            "",
            "localhost:99999",
            "http://u:p@localhost",
            "http://localhost/?key=secret",
            "ftp://localhost",
        ] {
            assert!(downloader_endpoint(raw, &Provider::Transmission).is_err());
        }
        let old = Settings {
            provider: Provider::Transmission,
            downloader_url: "http://127.0.0.1:9091/".into(),
            ..Settings::default()
        };
        let new = Settings {
            downloader_url: "127.0.0.1".into(),
            ..old.clone()
        };
        assert!(same_downloader(&old, &new));
    }
    #[test]
    fn never_reuses_a_secret_for_a_different_target() {
        assert!(resolve_secret(&SecretChange::Keep, "secret", false).is_err());
        assert_eq!(
            resolve_secret(&SecretChange::Clear, "secret", false).unwrap(),
            ""
        );
        assert_eq!(
            resolve_secret(&SecretChange::Keep, "secret", true).unwrap(),
            "secret"
        );
        assert_eq!(
            resolve_secret(&SecretChange::Set("new".into()), "old", false).unwrap(),
            "new"
        );
    }
}

#[cfg(test)]
mod locale_tests {
    #[test]
    fn translations_are_complete_and_have_matching_keys() {
        let messages: serde_json::Value =
            serde_json::from_str(include_str!("../../src/locales/messages.json")).unwrap();
        let en = messages["en-US"].as_object().unwrap();
        let zh = messages["zh-CN"].as_object().unwrap();
        assert_eq!(en.keys().collect::<Vec<_>>(), zh.keys().collect::<Vec<_>>());
        assert!(en
            .values()
            .chain(zh.values())
            .all(|v| v.as_str().is_some_and(|s| !s.is_empty())));
        for code in [
            "invalidUrl",
            "invalidSettings",
            "invalidSecret",
            "targetChanged",
            "credentialError",
            "storageError",
            "runtimeError",
            "timeout",
            "networkError",
            "authenticationError",
            "httpError",
            "invalidResponse",
        ] {
            assert!(en.contains_key(code));
        }
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn old_settings_remain_editable_but_network_policy_is_enforced() {
        let old = Settings {
            gateway_url: "http://gateway.example".into(),
            downloader_url: "http://192.168.1.5:8080".into(),
            ..Settings::default()
        };
        assert!(normalize(Settings::default()).is_ok());
        assert!(validate_stored(&Settings::default()).is_ok());
        assert!(validate_stored(&old).is_ok());
        // LAN downloader URLs no longer fail normalization; Gateway transport policy is independent.
        let lan = Settings {
            gateway_url: "https://gateway.example".into(),
            ..old
        };
        assert!(normalize(lan).is_ok());
        assert!(endpoint("https://gateway.example", true).is_ok());
        assert!(endpoint("ws://nas.local", false).is_err());
        if std::env::var("HELPER_ALLOW_INSECURE_DEV").as_deref() != Ok("true") {
            assert!(endpoint("http://gateway.example", true).is_err());
            assert!(endpoint("ws://gateway.example", true).is_err());
        }
    }
}
