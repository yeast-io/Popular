//! HDArea REST v1; credentials stay on this device and never enter torrent URLs.
use super::{resources::SearchResult, types::TorrentSource};
use crate::{diagnostics::Trace, errors::AgentError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use url::Url;

static READY: OnceLock<Mutex<BTreeMap<String, Instant>>> = OnceLock::new();
fn invalid() -> AgentError {
    AgentError::code("siteInvalidResponse")
}
pub(super) fn valid_key(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn identifier(value: &Value) -> Result<String, AgentError> {
    let value = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            value
                .as_u64()
                .filter(|n| *n <= crate::protocol::MAX_INTEGER)
                .map(|n| n.to_string())
        })
        .ok_or_else(invalid)?;
    if value.is_empty()
        || value.len() > 32
        || !value.bytes().all(|b| b.is_ascii_digit())
        || value.starts_with('0')
    {
        return Err(invalid());
    }
    Ok(value)
}
async fn read(
    base: &Url,
    key: &str,
    path: &str,
    body: Option<Value>,
    trace: &Trace,
) -> Result<Vec<u8>, AgentError> {
    if !valid_key(key) {
        return Err(AgentError::code("siteApiKeyRequired"));
    }
    let url = base
        .join(path)
        .map_err(|e| AgentError::caused("siteInvalidResponse", e))?;
    let api = url.path().starts_with("/api/v1/");
    if url.origin() != base.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (!api && (url.path() != "/download.php" || body.is_some()))
        || url
            .query_pairs()
            .any(|(k, _)| k.eq_ignore_ascii_case("apikey") || k.eq_ignore_ascii_case("passkey"))
    {
        return Err(invalid());
    }
    // Reserve a request slot per origin. A 429 cooldown is shared by subsequent operations.
    let origin = base.origin().ascii_serialization();
    let ready = READY.get_or_init(|| Mutex::new(BTreeMap::new()));
    let wait = {
        let mut lanes = ready.lock().await;
        let at = lanes.entry(origin.clone()).or_insert_with(Instant::now);
        let wait = at.saturating_duration_since(Instant::now());
        if wait > Duration::from_secs(15) {
            return Err(AgentError::code("siteRateLimited"));
        }
        *at = Instant::now() + wait + Duration::from_millis(if cfg!(test) { 0 } else { 1100 });
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    let builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Popular-Link-Agent/", env!("CARGO_PKG_VERSION")));
    let client = if matches!(base.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) {
        builder.no_proxy()
    } else {
        builder
    }
    .build()?;
    let mut request = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    if api {
        request = request.header("X-API-Key", key);
    }
    let mut response = super::http_diagnostics::send(
        request,
        super::types::Site::Hdarea,
        trace,
        "resource-sites.hdarea.api.http.started",
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        if status.as_u16() == 429 {
            let seconds = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60)
                .clamp(1, 86400);
            ready
                .lock()
                .await
                .insert(origin, Instant::now() + Duration::from_secs(seconds));
        }
        let code = match status.as_u16() {
            401 => "siteAuthentication",
            403 if api => "siteAuthentication",
            403 => "siteDownloadExpired",
            429 => "siteRateLimited",
            300..=399 => "siteRedirected",
            _ => "siteInvalidResponse",
        };
        return Err(match response.error_for_status_ref() {
            Err(e) => AgentError::caused(code, e.without_url()),
            Ok(_) => AgentError::code(code),
        }
        .http(status.as_u16()));
    }
    let max = if api {
        2 * 1024 * 1024
    } else {
        8 * 1024 * 1024
    };
    if response.content_length().is_some_and(|n| n > max) {
        return Err(invalid());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AgentError::from(e.without_url()))?
    {
        if data.len() + chunk.len() > max as usize {
            return Err(invalid());
        }
        data.extend_from_slice(&chunk);
    }
    trace.stage("resource-sites.hdarea.api.http.completed");
    Ok(data)
}
async fn data(
    base: &Url,
    key: &str,
    path: &str,
    body: Option<Value>,
    trace: &Trace,
) -> Result<Value, AgentError> {
    let bytes = read(base, key, path, body, trace).await?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| AgentError::caused("siteInvalidResponse", e))?;
    if value["success"] != true || value["code"] != 0 && value["code"] != "0" {
        return Err(AgentError::code(match value["code"].as_u64() {
            Some(401 | 403) => "siteAuthentication",
            Some(429) => "siteRateLimited",
            _ => "siteInvalidResponse",
        }));
    }
    Ok(value["data"].clone())
}
pub(super) async fn verify(base: &Url, key: &str, trace: &Trace) -> Result<String, AgentError> {
    identifier(&data(base, key, "/api/v1/user/profile", None, trace).await?["id"])
}
fn release(row: &Value, _base: &Url) -> Result<Value, AgentError> {
    let id = identifier(&row["id"])?;
    let name = row["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 512)
        .ok_or_else(invalid)?;
    let mut out = json!({"id":id,"title":name});
    for (source, target) in [
        ("small_descr", "description"),
        ("medium_name", "medium"),
        ("codec_name", "videoCodec"),
        ("audiocodec_name", "audioCodec"),
        ("team_name", "releaseGroup"),
        ("standard_name", "resolution"),
    ] {
        if let Some(value) = row[source].as_str().filter(|s| !s.is_empty()) {
            out[target] = json!(if source == "standard_name" && value == "4K" {
                "2160p"
            } else {
                value
            });
        }
    }
    for (source, target) in [("size", "sizeBytes"), ("seeders", "seeders")] {
        if !row[source].is_null() {
            let value = row[source]
                .as_u64()
                .filter(|v| *v <= crate::protocol::MAX_INTEGER)
                .ok_or_else(invalid)?;
            out[target] = json!(value);
        }
    }
    if let Some(value) = row["imdb_id"].as_str().filter(|s| {
        s.starts_with("tt") && s[2..].bytes().all(|b| b.is_ascii_digit()) && s.len() > 2
    }) {
        out["imdbId"] = json!(value);
    }
    if let Some(tags) = row["tags"].as_array() {
        let tags = tags
            .iter()
            .map(|v| {
                v.as_str()
                    .or_else(|| v["name"].as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        out["tags"] = json!(tags);
    }
    // The server supplies a human-readable timestamp; retain it for the existing contract.
    if let Some(value) = row["added"].as_str() {
        out["publishedAt"] = json!(value);
    }
    Ok(out)
}
pub(super) async fn search(
    base: &Url,
    key: &str,
    query: Option<String>,
    imdb: Option<String>,
    page: u32,
    _media: Option<String>,
    trace: &Trace,
) -> Result<SearchResult, AgentError> {
    let mut url = base.join("/api/v1/torrents").map_err(|_| invalid())?;
    {
        let mut params = url.query_pairs_mut();
        params
            .append_pair("page", &(page - 1).to_string())
            .append_pair("per_page", "50")
            .append_pair("incldead", "1")
            .append_pair("sort", "seeders")
            .append_pair("order", "desc");
        if let Some(id) = &imdb {
            params.append_pair("imdb", id);
        } else {
            params.append_pair("q", query.as_deref().ok_or_else(invalid)?);
        }
    }
    let value = data(base, key, url.as_str(), None, trace).await?;
    let items = value["items"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(invalid)?;
    if value["pagination"]["page"].as_u64() != Some((page - 1) as u64) {
        return Err(invalid());
    }
    let more = value["pagination"]["has_more"]
        .as_bool()
        .ok_or_else(invalid)?;
    let releases = items
        .iter()
        .map(|row| release(row, base))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(imdb) = imdb {
        if releases.iter().any(|r| r["imdbId"] != imdb) {
            return Err(invalid());
        }
    }
    Ok(SearchResult {
        releases,
        next_page: (more && page < 100).then_some(page + 1),
    })
}
pub(super) async fn detail(
    base: &Url,
    key: &str,
    id: &str,
    trace: &Trace,
) -> Result<Value, AgentError> {
    let value = data(base, key, &format!("/api/v1/torrents/{id}"), None, trace).await?;
    let out = release(&value, base)?;
    if out["id"] != id {
        return Err(invalid());
    }
    Ok(out)
}
pub(super) async fn torrent(
    base: &Url,
    key: &str,
    id: &str,
    trace: &Trace,
) -> Result<(TorrentSource, String), AgentError> {
    for attempt in 0..2 {
        let token = data(
            base,
            key,
            "/api/v1/torrents/genDlToken",
            Some(json!({"id":id})),
            trace,
        )
        .await?;
        if identifier(&token["id"])? != id || token["expires_in"].as_u64().is_none_or(|s| s == 0) {
            return Err(invalid());
        }
        let url = Url::parse(token["download_url"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        let ids = url
            .query_pairs()
            .filter(|(k, _)| k == "id")
            .map(|(_, v)| v.into_owned())
            .collect::<Vec<_>>();
        if url.as_str().len() > 8192
            || url.origin() != base.origin()
            || url.path() != "/download.php"
            || ids != [id]
            || !url
                .query_pairs()
                .any(|(k, v)| k == "dl_token" && !v.is_empty())
        {
            return Err(invalid());
        }
        match read(base, key, url.as_str(), None, trace).await {
            Ok(bytes) => {
                let hash = super::torrent::info_hash(&bytes)?;
                return Ok((TorrentSource::Metainfo(BASE64.encode(&bytes)), hash));
            }
            Err(e) if e.code == "siteDownloadExpired" && attempt == 0 => continue,
            Err(e) => return Err(e),
        }
    }
    Err(AgentError::code("siteDownloadExpired"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn maps_resource_metadata_without_exporting_private_download_links() {
        let base = Url::parse("https://hdarea.club/").unwrap();
        let row = json!({"id":123,"name":"Movie 2160p WEB-DL","small_descr":"第10-16集 中字","seeders":0,"size":1024,"imdb_id":"tt1234567","standard_name":"4K","tags":["Dolby Vision"],"download_url":"private-token"});
        let value = release(&row, &base).unwrap();
        assert_eq!(value["id"], "123");
        assert_eq!(value["seeders"], 0);
        assert_eq!(value["resolution"], "2160p");
        assert_eq!(value["description"], "第10-16集 中字");
        assert!(value.get("detailsUrl").is_none());
        assert!(!value.to_string().contains("private-token"));
        assert!(release(&json!({"id":0,"name":"Wrong"}), &base).is_err());
        assert!(!valid_key("uid=123; session=old-cookie"));
    }

    #[tokio::test]
    async fn expired_download_token_is_refreshed_once_without_cookie_or_permanent_key_on_download()
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let token_base = base.clone();
        let server = tokio::spawn(async move {
            for attempt in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 8192];
                let count = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..count]).to_lowercase();
                assert!(!request.contains("cookie:"));
                let (status, body) = if attempt % 2 == 0 {
                    assert!(request.starts_with("post /api/v1/torrents/gendltoken"));
                    assert!(request.contains(&format!("x-api-key: {}", "a".repeat(32))));
                    ("200 OK", json!({"success":true,"code":0,"data":{"id":42,"expires_in":1800,"download_url":format!("{}download.php?id=42&dl_token=short",token_base)}}).to_string())
                } else {
                    assert!(!request.contains("x-api-key:"));
                    if attempt == 1 {
                        ("403 Forbidden", String::new())
                    } else {
                        ("200 OK", "d4:infod4:name4:test6:pieces0:ee".into())
                    }
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let (source, hash) = torrent(&base, &"a".repeat(32), "42", &Trace::new())
            .await
            .unwrap();
        assert!(matches!(source, TorrentSource::Metainfo(_)));
        assert_eq!(
            hash,
            super::super::torrent::info_hash(b"d4:infod4:name4:test6:pieces0:ee").unwrap()
        );
        server.await.unwrap();
    }
}
