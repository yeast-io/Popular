use super::types::Site;
use crate::{diagnostics::Trace, errors::AgentError};
use dom_query::Document;
use reqwest::{header, redirect::Policy};
use serde_json::Value;
use std::{collections::BTreeSet, time::Duration};
use url::Url;

pub(super) fn endpoint(raw: &str, site: Site) -> Result<Url, AgentError> {
    let url = Url::parse(raw.trim()).map_err(|e| AgentError::caused("invalidUrl", e))?;
    let development = (cfg!(test)
        || std::env::var("HELPER_ALLOW_INSECURE_DEV").as_deref() == Ok("true"))
        && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if raw.len() > 2048
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.scheme() != "https" && !(development && url.scheme() == "http")
        || !if site == Site::Mteam {
            matches!(url.path(), "/" | "/api" | "/api/")
        } else {
            url.path() == "/"
        }
    {
        return Err(AgentError::code("invalidUrl"));
    }
    Ok(url)
}
fn user_id(value: &Value) -> Result<String, AgentError> {
    let id = match value {
        Value::String(v) => v.clone(),
        Value::Number(n) => n
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .map(|n| n.to_string())
            .unwrap_or_default(),
        _ => String::new(),
    };
    normalize_id(&id)
}
fn normalize_id(raw: &str) -> Result<String, AgentError> {
    if raw.is_empty()
        || raw.len() > 32
        || !raw.bytes().all(|c| c.is_ascii_digit())
        || raw.bytes().all(|c| c == b'0')
    {
        return Err(AgentError::code("siteInvalidResponse"));
    }
    Ok(raw.trim_start_matches('0').into())
}
pub(super) fn html_identity(bytes: &[u8], base: &Url, site: Site) -> Result<String, AgentError> {
    let html =
        std::str::from_utf8(bytes).map_err(|e| AgentError::caused("siteInvalidResponse", e))?;
    let document = Document::from(html);
    let title = document.select("title").text().to_lowercase();
    if document
        .select("#challenge-form, .cf-turnstile, iframe[src*='captcha']")
        .exists()
        || ["just a moment", "access denied", "captcha", "验证码"]
            .iter()
            .any(|s| title.contains(s))
    {
        return Err(AgentError::code("siteBlocked"));
    }
    if document
        .select("form[action*='takelogin'], input[type='password']")
        .exists()
    {
        return Err(AgentError::code("siteAuthentication"));
    }
    if site == Site::Hdarea && !document.select("a[href='usercp.php']").exists() {
        return Err(AgentError::code("siteAuthentication"));
    }
    let selector = if site == Site::Hdarea {
        "#info_block a[href*='userdetails.php']"
    } else {
        "#site_header .userinfo a[href*='userdetails.php']"
    };
    let mut ids = BTreeSet::new();
    for link in document.select(selector).iter() {
        let href = link
            .attr("href")
            .ok_or_else(|| AgentError::code("siteInvalidResponse"))?;
        let url = base
            .join(&href)
            .map_err(|e| AgentError::caused("siteInvalidResponse", e))?;
        if url.origin() != base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/userdetails.php"
        {
            return Err(AgentError::code("siteInvalidResponse"));
        }
        let values: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "id")
            .map(|(_, value)| value.into_owned())
            .collect();
        if values.len() != 1 {
            return Err(AgentError::code("siteInvalidResponse"));
        }
        ids.insert(normalize_id(&values[0])?);
    }
    if ids.len() != 1 {
        return Err(AgentError::code(
            if ids.is_empty() && site == Site::Hdwing {
                "siteAuthentication"
            } else {
                "siteInvalidResponse"
            },
        ));
    }
    Ok(ids.into_iter().next().unwrap())
}
pub(super) fn mteam_identity(bytes: &[u8]) -> Result<String, AgentError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| AgentError::caused("siteInvalidResponse", e))?;
    if !matches!(value["code"].as_str(), Some("0" | "SUCCESS")) && value["code"].as_i64() != Some(0)
    {
        let message = value["message"].as_str().unwrap_or_default().to_lowercase();
        let authentication = value["code"].as_i64() == Some(401)
            || value["code"] == "401"
            || ["key", "token", "auth", "令牌", "無效", "无效"]
                .iter()
                .any(|s| message.contains(s));
        return Err(AgentError::code(if authentication {
            "siteAuthentication"
        } else {
            "siteRemoteError"
        }));
    }
    user_id(&value["data"]["id"])
}
/// Fixed verification paths only. Credentials never follow redirects or enter URLs/logs.
pub(super) async fn verify(
    site: Site,
    base: &Url,
    credential: &str,
    trace: &Trace,
) -> Result<String, AgentError> {
    if site == Site::Hdarea {
        return super::hdarea::verify(base, credential, trace).await;
    }
    let builder = reqwest::Client::builder()
        .user_agent(concat!("Popular-Link-Agent/", env!("CARGO_PKG_VERSION")))
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15));
    let client = if matches!(base.host_str(), Some("127.0.0.1" | "[::1]" | "localhost")) {
        builder.no_proxy()
    } else {
        builder
    }
    .build()?;
    let target = if site == Site::Mteam {
        base.join("/api/member/profile")
    } else {
        base.join("index.php")
    }
    .map_err(|e| AgentError::caused("invalidUrl", e))?;
    trace.stage(&format!(
        "resource-sites.{}.verification.http.started",
        site.id()
    ));
    let request = if site == Site::Mteam {
        client
            .post(target)
            .header("x-api-key", credential)
            .json(&serde_json::json!({}))
    } else {
        client.get(target).header(header::COOKIE, credential)
    };
    let mut response = request.send().await?;
    let status = response.status();
    let remote_error = |code| {
        match response.error_for_status_ref() {
            Err(error) => AgentError::caused(code, error),
            Ok(_) => AgentError::code(code),
        }
        .http(status.as_u16())
    };
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(remote_error("siteAuthentication"));
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(remote_error("siteBlocked"));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(remote_error("siteRateLimited"));
    }
    if status.is_redirection() {
        return Err(remote_error("siteRedirected"));
    }
    if !status.is_success() {
        return Err(remote_error("siteRemoteError"));
    }
    let limit = if site == Site::Mteam {
        65536
    } else {
        2 * 1024 * 1024
    };
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(AgentError::code("siteInvalidResponse"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > limit {
            return Err(AgentError::code("siteInvalidResponse"));
        }
        bytes.extend_from_slice(&chunk);
    }
    trace.stage(&format!(
        "resource-sites.{}.verification.http.completed",
        site.id()
    ));
    if site == Site::Mteam {
        mteam_identity(&bytes)
    } else {
        html_identity(&bytes, base, site)
    }
}
