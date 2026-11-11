//! Typed site operations; no arbitrary URL, method, header or credential RPC surface.
use super::{
    types::{Site, SiteSecrets},
    verification, ResourceSites,
};
use crate::{credentials::CredentialStore, diagnostics::Trace, errors::AgentError};
use dom_query::Document;
use reqwest::{header, redirect::Policy, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

#[derive(Clone, Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum ResourceRequest {
    List,
    Search {
        site: Site,
        query: Option<String>,
        #[serde(rename = "imdbId")]
        imdb_id: Option<String>,
        page: Option<u32>,
        #[serde(rename = "mediaType")]
        media_type: Option<String>,
    },
    Detail {
        site: Site,
        #[serde(rename = "resourceId")]
        resource_id: String,
    },
    Prepare {
        site: Site,
        #[serde(rename = "resourceId")]
        resource_id: String,
        #[serde(rename = "commandId")]
        command_id: String,
        version: String,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub releases: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page: Option<u32>,
}
fn invalid() -> AgentError {
    AgentError::code("siteInvalidResponse")
}
fn id(raw: &str) -> Result<(), AgentError> {
    if raw.is_empty() || raw.len() > 32 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    Ok(())
}
fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| *n <= crate::protocol::MAX_INTEGER)
}
fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
}
fn success(bytes: &[u8]) -> Result<Value, AgentError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| AgentError::caused("siteInvalidResponse", e))?;
    if value["code"] != 0 && value["code"] != "0" && value["code"] != "SUCCESS" {
        let message = value["message"].as_str().unwrap_or_default();
        return Err(AgentError::code(
            if message
                .replace('種', "种")
                .replace('當', "当")
                .replace("下載", "下载")
                .trim()
                .strip_prefix("相同种子当天最多下载")
                .is_some_and(|suffix| {
                    let digits = suffix
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>();
                    !digits.is_empty()
                        && matches!(
                            &suffix[digits.len()..],
                            "次" | "次。" | "次." | "次!" | "次！"
                        )
                })
            {
                "siteDownloadLimited"
            } else if value["code"] == 401 || value["code"] == "401" {
                "siteAuthentication"
            } else {
                "siteRemoteError"
            },
        ));
    }
    Ok(value)
}
fn client(url: &Url) -> Result<reqwest::Client, AgentError> {
    let builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .user_agent(concat!("Popular-Link-Agent/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15));
    Ok(
        if matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost")) {
            builder.no_proxy()
        } else {
            builder
        }
        .build()?,
    )
}
async fn bytes(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, AgentError> {
    let status = response.status();
    if !status.is_success() {
        return Err(AgentError::code(match status.as_u16() {
            401 => "siteAuthentication",
            403 => "siteBlocked",
            429 => "siteRateLimited",
            300..=399 => "siteRedirected",
            _ => "siteRemoteError",
        })
        .http(status.as_u16()));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > limit {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn request(
    site: Site,
    base: &Url,
    secrets: &SiteSecrets,
    path: &str,
    body: Option<Value>,
    form: Option<&str>,
    trace: &Trace,
) -> Result<Vec<u8>, AgentError> {
    let url = base
        .join(path)
        .map_err(|e| AgentError::caused("invalidUrl", e))?;
    if url.origin() != base.origin() {
        return Err(invalid());
    }
    trace.stage(&format!("resource-sites.{}.request.started", site.id()));
    let mut request = client(&url)?.request(
        if body.is_some() || form.is_some() {
            Method::POST
        } else {
            Method::GET
        },
        url,
    );
    request = if site == Site::Mteam {
        request.header("x-api-key", &secrets.credential)
    } else {
        request.header(header::COOKIE, &secrets.credential)
    };
    if let Some(body) = body {
        request = request.json(&body);
    }
    if let Some(form) = form {
        request = request
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(form.to_owned());
    }
    let result = bytes(request.send().await?, 2 * 1024 * 1024).await?;
    trace.stage(&format!("resource-sites.{}.request.completed", site.id()));
    Ok(result)
}
fn html(
    bytes: &[u8],
    base: &Url,
    site: Site,
    secrets: &SiteSecrets,
) -> Result<Document, AgentError> {
    if verification::html_identity(bytes, base, site)? != secrets.external_user_id {
        return Err(AgentError::code("siteAccountChanged"));
    }
    Ok(Document::from(
        std::str::from_utf8(bytes).map_err(|_| invalid())?,
    ))
}
fn size(text: &str) -> Option<u64> {
    let words = text
        .replace(',', "")
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if words.len() != 2 {
        return None;
    }
    let value: f64 = words[0].parse().ok()?;
    let power = match words[1].to_uppercase().as_str() {
        "B" => 0,
        "KB" | "KIB" => 1,
        "MB" | "MIB" => 2,
        "GB" | "GIB" => 3,
        "TB" | "TIB" => 4,
        _ => return None,
    };
    let bytes = value * 1024f64.powi(power);
    (bytes.is_finite() && bytes >= 0.0 && bytes <= crate::protocol::MAX_INTEGER as f64)
        .then_some(bytes.round() as u64)
}
fn imdb(text: &str) -> Option<String> {
    let start = text.find("tt")?;
    let digits = text[start + 2..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    (!digits.is_empty() && digits.len() <= 20).then(|| format!("tt{digits}"))
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn search(
    site: Site,
    base: &Url,
    secrets: &SiteSecrets,
    query: Option<String>,
    imdb_id: Option<String>,
    page: u32,
    media_type: Option<String>,
    trace: &Trace,
) -> Result<SearchResult, AgentError> {
    if !(1..=100).contains(&page)
        || query
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.len() > 800)
        || imdb_id.as_ref().is_some_and(|s| {
            !s.starts_with("tt") || s.len() > 22 || !s[2..].bytes().all(|b| b.is_ascii_digit())
        })
        || query.is_none() && imdb_id.is_none()
        || media_type
            .as_ref()
            .is_some_and(|s| !matches!(s.as_str(), "movie" | "tv"))
    {
        return Err(invalid());
    }
    if site == Site::Mteam {
        let mut body = json!({"pageNumber":page,"pageSize":50,"mode":if media_type.as_deref()==Some("tv"){ "tvshow" }else{"movie"},"visible":1,"sortField":"SEEDERS","sortDirection":"DESC"});
        if let Some(imdb) = imdb_id {
            body["imdb"] = json!(format!("https://www.imdb.com/title/{imdb}/"));
        } else {
            body["keyword"] = json!(query.unwrap());
        }
        let payload = success(
            &request(
                site,
                base,
                secrets,
                "/api/torrent/search",
                Some(body),
                None,
                trace,
            )
            .await?,
        )?;
        let rows = payload["data"]["data"]
            .as_array()
            .or_else(|| payload["data"]["list"].as_array())
            .or_else(|| payload["data"].as_array())
            .ok_or_else(invalid)?;
        if rows.len() > 100 {
            return Err(invalid());
        }
        let mut releases = Vec::new();
        for row in rows {
            let visible = matches!(row["status"]["visible"], Value::Bool(true))
                || row["status"]["visible"] == 1
                || row["status"]["visible"] == "1";
            let banned = matches!(row["status"]["banned"], Value::Bool(true))
                || row["status"]["banned"] == 1
                || row["status"]["banned"] == "1";
            if !visible || banned {
                continue;
            }
            let resource_id = text(&row["id"]).ok_or_else(invalid)?;
            id(&resource_id)?;
            let title = row["name"]
                .as_str()
                .filter(|s| !s.is_empty() && s.chars().count() <= 512)
                .ok_or_else(invalid)?;
            let mut release = json!({"id":resource_id,"title":title});
            if let Some(seed) = number(&row["status"]["seeders"]) {
                release["seeders"] = json!(seed);
            }
            if let Some(size) = number(&row["size"]) {
                release["sizeBytes"] = json!(size);
            }
            if let Some(value) = row["smallDescr"].as_str() {
                release["description"] = json!(value.chars().take(512).collect::<String>());
            }
            if let Some(value) = row["imdb"].as_str().and_then(imdb) {
                release["imdbId"] = json!(value);
            }
            if let Some(value) = row["createdDate"].as_str() {
                if value.len() <= 64 {
                    release["publishedAt"] = json!(value);
                }
            }
            if let Some(tags) = row["labelsNew"].as_array() {
                release["tags"] = json!(tags
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty() && s.len() <= 64)
                    .take(16)
                    .collect::<Vec<_>>());
            }
            releases.push(release);
        }
        let more =
            number(&payload["data"]["total"]).map_or(rows.len() == 50, |n| page as u64 * 50 < n);
        return Ok(SearchResult {
            releases,
            next_page: (more && page < 100).then_some(page + 1),
        });
    }
    let mut url = base.join("torrents.php").map_err(|_| invalid())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("search", imdb_id.as_deref().or(query.as_deref()).unwrap())
            .append_pair(
                "search_area",
                if site == Site::Hdwing && imdb_id.is_some() {
                    "4"
                } else {
                    "0"
                },
            )
            .append_pair("search_mode", "0")
            .append_pair("page", &(page - 1).to_string())
            .append_pair("incldead", if site == Site::Hdarea { "1" } else { "0" });
    }
    let path = format!("{}?{}", url.path(), url.query().unwrap());
    let document = html(
        &request(site, base, secrets, &path, None, None, trace).await?,
        base,
        site,
        secrets,
    )?;
    let selector = if site == Site::Hdarea {
        "table.torrents > tbody > tr:has(table.torrentname)"
    } else {
        "table.torrent_list > tbody > tr:has(td.t_name)"
    };
    let rows = document.select(selector);
    if !rows.exists()
        && !["没有找到", "没有种子", "無符合", "无匹配", "没有搜索结果"]
            .iter()
            .any(|text| document.text().contains(text))
        && !document.text().to_lowercase().contains("no results")
        && !document.text().to_lowercase().contains("no torrents")
    {
        return Err(invalid());
    }
    let mut releases = Vec::new();
    for row in rows.iter() {
        if releases.len() >= 100 {
            return Err(invalid());
        }
        let link = row
            .select(if site == Site::Hdarea {
                ".torrentname a[href^='details.php?id=']"
            } else {
                "td.t_name h3 a[href*='details.php']"
            })
            .first();
        let href = link.attr("href").ok_or_else(invalid)?;
        let url = base.join(&href).map_err(|_| invalid())?;
        let ids = url
            .query_pairs()
            .filter(|(k, _)| k == "id")
            .map(|(_, v)| v.into_owned())
            .collect::<Vec<_>>();
        if url.origin() != base.origin() || url.path() != "/details.php" || ids.len() != 1 {
            return Err(invalid());
        }
        id(&ids[0])?;
        let title = link
            .attr("title")
            .map(|v| v.to_string())
            .unwrap_or_else(|| link.text().to_string())
            .trim()
            .to_owned();
        if title.is_empty() || title.chars().count() > 512 {
            return Err(invalid());
        }
        let mut release = json!({"id":ids[0],"title":title});
        let cells = row.children().filter("td");
        let values = cells
            .iter()
            .map(|cell| cell.text().to_string())
            .collect::<Vec<_>>();
        let (raw_size, raw_seed) = if site == Site::Hdwing {
            (
                row.select("td.t_size").text().to_string(),
                row.select("td.t_torrents").text().to_string(),
            )
        } else if values.len() >= 5 {
            (
                values[values.len() - 5].clone(),
                values[values.len() - 4].clone(),
            )
        } else {
            return Err(invalid());
        };
        if let Some(value) = size(&raw_size) {
            release["sizeBytes"] = json!(value);
        }
        let raw_seed = raw_seed
            .chars()
            .filter(|c| !c.is_whitespace() && *c != ',')
            .collect::<String>();
        if !raw_seed.is_empty() {
            if let Ok(value) = raw_seed.parse::<u64>() {
                if value <= crate::protocol::MAX_INTEGER {
                    release["seeders"] = json!(value);
                }
            }
        }
        let description = if site == Site::Hdarea {
            let fragment = Document::from(row.select(".torrentname").html().to_string().as_str());
            fragment.select("a, img, script, style").remove();
            fragment
                .text()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            row.select("td.t_name h4").text().to_string()
        };
        if !description.trim().is_empty() {
            release["description"] =
                json!(description.trim().chars().take(512).collect::<String>());
        }
        let time = row
            .select("span[title]")
            .iter()
            .filter_map(|node| node.attr("title").map(|s| s.to_string()))
            .find(|s| s.len() == 19 && s.as_bytes().get(4) == Some(&b'-'));
        if let Some(time) = time {
            release["publishedAt"] = json!(time);
        }
        for a in row.select("a[href*='imdb.com/title/tt']").iter() {
            if let Some(value) = a.attr("href").and_then(|s| imdb(&s)) {
                release["imdbId"] = json!(value);
                break;
            }
        }
        if !releases.iter().any(|r: &Value| r["id"] == release["id"]) {
            releases.push(release);
        }
    }
    let more = document
        .select("a[href*='torrents.php'][href*='page=']")
        .iter()
        .any(|link| {
            link.attr("href")
                .and_then(|href| base.join(&href).ok())
                .is_some_and(|url| {
                    url.origin() == base.origin()
                        && url.path() == "/torrents.php"
                        && url
                            .query_pairs()
                            .any(|(k, v)| k == "page" && v == page.to_string())
                })
        });
    Ok(SearchResult {
        releases,
        next_page: (more && page < 100).then_some(page + 1),
    })
}
pub(super) async fn detail(
    site: Site,
    base: &Url,
    secrets: &SiteSecrets,
    resource_id: &str,
    trace: &Trace,
) -> Result<Value, AgentError> {
    id(resource_id)?;
    if site == Site::Mteam {
        return Err(AgentError::code("siteUnsupported"));
    }
    let document = html(
        &request(
            site,
            base,
            secrets,
            &format!("details.php?id={resource_id}"),
            None,
            None,
            trace,
        )
        .await?,
        base,
        site,
        secrets,
    )?;
    let heading = document
        .select(if site == Site::Hdarea {
            "h1"
        } else {
            "#site_content h2"
        })
        .first();
    let title = heading.text().trim().to_owned();
    if title.is_empty() || title.chars().count() > 512 {
        return Err(invalid());
    }
    let mut release = json!({"id":resource_id,"title":title});
    for link in document.select("a[href*='imdb.com/title/tt']").iter() {
        if let Some(value) = link.attr("href").and_then(|s| imdb(&s)) {
            release["imdbId"] = json!(value);
            break;
        }
    }
    Ok(release)
}
pub(super) async fn torrent(
    site: Site,
    base: &Url,
    secrets: &SiteSecrets,
    resource_id: &str,
    trace: &Trace,
) -> Result<(String, String), AgentError> {
    id(resource_id)?;
    let url = match site {
        Site::Mteam => {
            let form = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("id", resource_id)
                .finish();
            let payload = success(
                &request(
                    site,
                    base,
                    secrets,
                    "/api/torrent/genDlToken",
                    None,
                    Some(&form),
                    trace,
                )
                .await?,
            )?;
            Url::parse(payload["data"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?
        }
        Site::Hdarea => {
            let mut url = base.join("download.php").map_err(|_| invalid())?;
            url.query_pairs_mut()
                .append_pair("id", resource_id)
                .append_pair("passkey", &secrets.passkey);
            url
        }
        Site::Hdwing => {
            let document = html(
                &request(
                    site,
                    base,
                    secrets,
                    &format!("details.php?id={resource_id}"),
                    None,
                    None,
                    trace,
                )
                .await?,
                base,
                site,
                secrets,
            )?;
            let mut urls = std::collections::BTreeSet::new();
            for link in document
                .select("#site_content a[href*='download.php']")
                .iter()
            {
                let Some(href) = link.attr("href") else {
                    continue;
                };
                let url = base.join(&href).map_err(|_| invalid())?;
                if url.origin() != base.origin() || url.path() != "/download.php" {
                    return Err(invalid());
                }
                let hashes = url
                    .query_pairs()
                    .filter(|(k, _)| k == "hash")
                    .map(|(_, v)| v.into_owned())
                    .collect::<Vec<_>>();
                let users = url
                    .query_pairs()
                    .filter(|(k, _)| k == "uid")
                    .map(|(_, v)| v.into_owned())
                    .collect::<Vec<_>>();
                if hashes.is_empty() || users.is_empty() {
                    continue;
                }
                if hashes.len() != 1
                    || users.len() != 1
                    || users[0] != secrets.external_user_id
                    || hashes[0].len() > 2048
                {
                    return Err(invalid());
                }
                let parts = hashes[0].split('.').collect::<Vec<_>>();
                if parts.len() != 2 || parts[1].is_empty() {
                    return Err(invalid());
                }
                let decoded =
                    String::from_utf8(crate::protocol::decode(parts[0])?).map_err(|_| invalid())?;
                if decoded != format!("1\n{resource_id}\n{}", secrets.external_user_id) {
                    return Err(invalid());
                }
                urls.insert(url.to_string());
            }
            if urls.len() != 1 {
                return Err(invalid());
            }
            Url::parse(&urls.into_iter().next().unwrap()).map_err(|_| invalid())?
        }
    };
    let dev = std::env::var("HELPER_ALLOW_INSECURE_DEV").as_deref() == Ok("true")
        && url.origin() == base.origin()
        && matches!(base.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.as_str().len() > 8192
        || url.scheme() != "https" && !(dev && url.scheme() == "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    if site != Site::Mteam && url.origin() != base.origin() {
        return Err(invalid());
    }
    // No API key or Cookie is attached to transferable torrent URLs.
    trace.stage("resource-sites.torrent.read.started");
    let bytes = bytes(
        client(&url)?.get(url.clone()).send().await?,
        8 * 1024 * 1024,
    )
    .await?;
    let hash = super::torrent::info_hash(&bytes)?;
    trace.stage("resource-sites.torrent.read.completed");
    Ok((url.to_string(), hash))
}
impl<C: CredentialStore + Send + Sync + 'static> ResourceSites<C> {
    pub(crate) async fn operate(
        &self,
        input: ResourceRequest,
        context: &crate::protocol::Context,
        tickets: &super::tickets::ResourceTickets,
        trace: &Trace,
    ) -> Result<Value, AgentError> {
        if matches!(input, ResourceRequest::List) {
            let snapshots = self.list(trace).await?;
            let rows = self.load()?;
            return Ok(json!(snapshots.into_iter().map(|s|{ let mut value=json!({"site":s.site,"enabled":s.enabled,"status":s.status,"verifiedAt":s.verified_at,"version":rows.sites.iter().find(|r|r.site==s.site).map(|r|crate::protocol::fingerprint(&json!([r.credential_id,r.base_url]))).unwrap_or_default()}); if s.base_url.starts_with("https://") { value["baseUrl"]=json!(s.base_url); } value }).collect::<Vec<_>>()));
        }
        let site = match &input {
            ResourceRequest::List => unreachable!(),
            ResourceRequest::Search { site, .. }
            | ResourceRequest::Detail { site, .. }
            | ResourceRequest::Prepare { site, .. } => *site,
        };
        let _site = self.sites[site.index()].lock().await;
        let row = self
            .load()?
            .sites
            .into_iter()
            .find(|r| r.site == site)
            .ok_or_else(|| AgentError::code("siteNotConfigured"))?;
        if !row.enabled || !matches!(row.status, super::types::Status::ConfiguredValid) {
            return Err(AgentError::code("siteAuthentication"));
        }
        let secrets = self.secrets(&row)?;
        let base = verification::endpoint(&row.base_url, site)?;
        let result = async {
            match input {
                ResourceRequest::Search {
                    query,
                    imdb_id,
                    page,
                    media_type,
                    ..
                } => serde_json::to_value(
                    search(
                        site,
                        &base,
                        &secrets,
                        query,
                        imdb_id,
                        page.unwrap_or(1),
                        media_type,
                        trace,
                    )
                    .await?,
                )
                .map_err(AgentError::from),
                ResourceRequest::Detail { resource_id, .. } => {
                    detail(site, &base, &secrets, &resource_id, trace).await
                }
                ResourceRequest::Prepare {
                    resource_id,
                    command_id,
                    version,
                    ..
                } => {
                    if version
                        != crate::protocol::fingerprint(&json!([row.credential_id, row.base_url]))
                    {
                        return Err(AgentError::code("siteTargetChanged"));
                    }
                    if !crate::protocol::id(&command_id) {
                        return Err(invalid());
                    }
                    if let Some(value) = tickets.existing(context, &command_id, &row, &resource_id)
                    {
                        return Ok(value);
                    }
                    let (url, hash) = torrent(site, &base, &secrets, &resource_id, trace).await?;
                    tickets.insert(context, &command_id, &row, &resource_id, url, hash)
                }
                ResourceRequest::List => unreachable!(),
            }
        }
        .await;
        if let Err(error) = &result {
            if matches!(
                error.code,
                "siteAuthentication" | "siteBlocked" | "siteAccountChanged"
            ) {
                let _commit = self.commit.lock().await;
                let mut stored = self.load()?;
                if let Some(current) = stored
                    .sites
                    .iter_mut()
                    .find(|r| r.site == site && r.credential_id == row.credential_id)
                {
                    current.status = super::types::Status::ConfiguredInvalid;
                    current.last_error = Some(error.code.into());
                    crate::journal::atomic(&self.directory, super::FILE, &stored)?;
                }
            }
        }
        if let Ok(value) = &result {
            let text = value.to_string();
            if text.len() > 55_000
                || (!secrets.credential.is_empty() && text.contains(&secrets.credential))
                || (!secrets.passkey.is_empty() && text.contains(&secrets.passkey))
            {
                return Err(invalid());
            }
        }
        result
    }
}
#[cfg(test)]
mod parser_tests {
    use super::*;
    #[test]
    fn resource_pages_must_keep_the_verified_local_account() {
        let base = Url::parse("https://site.example/").unwrap();
        let secrets = SiteSecrets {
            site: Site::Hdarea,
            base_url: base.to_string(),
            credential: "synthetic-cookie".into(),
            passkey: "synthetic-passkey".into(),
            external_user_id: "8811".into(),
        };
        let page = b"<a href='usercp.php'>profile</a><div id='info_block'><a href='userdetails.php?id=8811'>me</a></div>";
        assert!(html(page, &base, Site::Hdarea, &secrets).is_ok());
        let changed = String::from_utf8(page.to_vec())
            .unwrap()
            .replace("8811", "8812");
        assert_eq!(
            html(changed.as_bytes(), &base, Site::Hdarea, &secrets)
                .err()
                .unwrap()
                .code,
            "siteAccountChanged"
        );
    }
    #[test]
    fn table_rows_keep_only_direct_cells() {
        let doc = Document::from("<table class='torrents'><tr><td><table class='torrentname'><tr><td><a href='details.php?id=123'>Movie</a></td></tr></table></td><td>1 GB</td><td>0</td><td>0</td><td>0</td><td>1</td></tr></table>");
        let rows = doc.select("table.torrents > tbody > tr:has(table.torrentname)");
        assert_eq!(rows.length(), 1);
        let row = rows.first();
        assert_eq!(
            row.select(".torrentname a[href^='details.php?id=']")
                .length(),
            1
        );
        assert_eq!(row.children().filter("td").length(), 6);
    }
}
