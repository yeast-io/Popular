//! Only HTTP URL submission; never reads torrent files or supplies a download directory.
use crate::{
    diagnostics::Trace,
    downloader::{body, checked},
    errors::AgentError,
    settings::{Provider, Settings},
};
use reqwest::{header, Client};
use serde_json::{json, Value};
use std::time::Duration;

pub struct Downloader {
    client: Client,
    settings: Settings,
    password: String,
    cookie: Option<String>,
    session: Option<String>,
    modern: bool,
}
impl Downloader {
    pub async fn connect(
        mut settings: Settings,
        password: String,
        trace: &Trace,
    ) -> Result<Self, AgentError> {
        if !settings.downloader_configured {
            return Err(AgentError::code("downloaderRequired"));
        }
        settings.downloader_url =
            crate::settings::downloader_endpoint(&settings.downloader_url, &settings.provider)?
                .to_string();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()?;
        let mut this = Self {
            client,
            settings,
            password,
            cookie: None,
            session: None,
            modern: false,
        };
        trace.stage("downloader.connect.started");
        if this.settings.provider == Provider::Qbittorrent {
            let response = checked(
                this.qb("auth/login", true)
                    .form(&[
                        ("username", &this.settings.username),
                        ("password", &this.password),
                    ])
                    .send()
                    .await?,
            )?;
            this.cookie = response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .filter_map(|v| v.split(';').next())
                .find(|v| v.starts_with("SID="))
                .map(str::to_owned);
            if body(response).await? != b"Ok." {
                return Err(AgentError::code("authenticationError"));
            }
        } else {
            this.rpc("session-get", json!({"fields":["version"]}))
                .await?;
        }
        trace.stage("downloader.connect.completed");
        Ok(this)
    }
    fn qb(&self, path: &str, post: bool) -> reqwest::RequestBuilder {
        let base = self.settings.downloader_url.trim_end_matches('/');
        let url = format!("{base}/api/v2/{path}");
        let query = if post {
            self.client.post(url)
        } else {
            self.client.get(url)
        };
        let mut query = query.header(header::REFERER, format!("{base}/"));
        if let Some(cookie) = &self.cookie {
            query = query.header(header::COOKIE, cookie);
        }
        query
    }
    async fn rpc(&mut self, method: &str, args: Value) -> Result<Value, AgentError> {
        for attempt in 0..2 {
            let payload = if self.modern {
                json!({"jsonrpc":"2.0","id":1,"method":method.replace('-',"_"),"params":args})
            } else {
                json!({"method":method,"arguments":args,"tag":1})
            };
            let mut query = self
                .client
                .post(&self.settings.downloader_url)
                .basic_auth(&self.settings.username, Some(&self.password))
                .json(&payload);
            if let Some(session) = &self.session {
                query = query.header("x-transmission-session-id", session);
            }
            let response = query.send().await?;
            if response.status().as_u16() == 409 && attempt == 0 {
                self.session = Some(
                    response
                        .headers()
                        .get("x-transmission-session-id")
                        .and_then(|v| v.to_str().ok())
                        .filter(|s| !s.is_empty() && s.len() <= 4096)
                        .ok_or(AgentError::code("invalidResponse"))?
                        .into(),
                );
                self.modern = response
                    .headers()
                    .get("x-transmission-rpc-version")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.split('.').next()?.parse::<u32>().ok())
                    .is_some_and(|n| n >= 6);
                continue;
            }
            let value: Value = serde_json::from_slice(&body(checked(response)?).await?)?;
            return if self.modern
                && value["jsonrpc"] == "2.0"
                && value["id"] == 1
                && value.get("error").is_none()
            {
                Ok(value["result"].clone())
            } else if !self.modern && value["result"] == "success" && value["tag"] == 1 {
                Ok(value["arguments"].clone())
            } else {
                Err(AgentError::code("invalidResponse"))
            };
        }
        Err(AgentError::code("invalidResponse"))
    }
    pub async fn tasks(&mut self, hash: &str) -> Result<Vec<Value>, AgentError> {
        self.tasks_many(&[hash.to_owned()]).await
    }
    pub async fn tasks_many(&mut self, hashes: &[String]) -> Result<Vec<Value>, AgentError> {
        if hashes.is_empty() {
            return Ok(Vec::new());
        }
        let value: Value = if self.settings.provider == Provider::Qbittorrent {
            serde_json::from_slice(
                &body(checked(
                    // qBittorrent's API task ID may differ from either full info-hash.
                    // Inspect the local list, then retain only the requested full hashes.
                    self.qb("torrents/info", false).send().await?,
                )?)
                .await?,
            )?
        } else {
            let fields = if self.modern {
                json!([
                    "id",
                    "hash_string",
                    "labels",
                    "status",
                    "percent_done",
                    "rate_download",
                    "rate_upload",
                    "total_size",
                    "downloaded_ever",
                    "uploaded_ever",
                    "error"
                ])
            } else {
                json!([
                    "id",
                    "hashString",
                    "labels",
                    "status",
                    "percentDone",
                    "rateDownload",
                    "rateUpload",
                    "totalSize",
                    "downloadedEver",
                    "uploadedEver",
                    "error"
                ])
            };
            self.rpc("torrent-get", json!({"ids":hashes,"fields":fields}))
                .await?["torrents"]
                .clone()
        };
        let items = value
            .as_array()
            .ok_or(AgentError::code("invalidResponse"))?;
        let matching: Vec<_> = items
            .iter()
            .filter(|task| hashes.iter().any(|hash| matches_hash(task, hash)))
            .cloned()
            .collect();
        if matching.len() > hashes.len() {
            return Err(AgentError::code("invalidResponse"));
        }
        Ok(matching)
    }
    pub async fn add(&mut self, url: &str, marker: &str) -> Result<bool, AgentError> {
        if self.settings.provider == Provider::Qbittorrent {
            let bytes = body(checked(
                self.qb("torrents/add", true)
                    .form(&[("urls", url), ("tags", marker)])
                    .send()
                    .await?,
            )?)
            .await?;
            if bytes != b"Ok." {
                return Err(AgentError::code("invalidResponse"));
            }
            Ok(true)
        } else {
            let value = self
                .rpc("torrent-add", json!({"filename":url,"labels":[marker]}))
                .await?;
            // Duplicate responses are never adopted, even if the hash matches.
            if value
                .get("torrent-duplicate")
                .or(value.get("torrent_duplicate"))
                .is_some()
            {
                return Ok(false);
            }
            if value
                .get("torrent-added")
                .or(value.get("torrent_added"))
                .is_none()
            {
                return Err(AgentError::code("invalidResponse"));
            }
            Ok(true)
        }
    }
}
pub fn matches_hash(task: &Value, expected: &str) -> bool {
    let full_fields = ["infohash_v1", "infohash_v2"];
    let fields: &[&str] = if full_fields
        .iter()
        .any(|field| task[field].as_str().is_some_and(|value| !value.is_empty()))
    {
        &full_fields
    } else {
        &["hash", "hashString", "hash_string"]
    };
    fields.iter().any(|field| {
        task[field]
            .as_str()
            .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
    })
}
pub fn owned(task: &Value, marker: &str) -> bool {
    task["tags"]
        .as_str()
        .is_some_and(|s| s.split(',').any(|s| s.trim() == marker))
        || task["labels"]
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s.as_str() == Some(marker)))
}
pub fn status(task: &Value, provider: &Provider) -> Result<Value, AgentError> {
    let number = |a: &str, b: &str| {
        task[a]
            .as_f64()
            .or(task[b].as_f64())
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or(AgentError::code("invalidResponse"))
    };
    let (state, progress, down, up, total, downloaded, uploaded) =
        if *provider == Provider::Qbittorrent {
            let state = task["state"]
                .as_str()
                .ok_or(AgentError::code("invalidResponse"))?;
            let progress = number("progress", "progress")?;
            let mapped = if matches!(state, "error" | "missingFiles") {
                "failed"
            } else if state.starts_with("paused") || state.starts_with("stopped") {
                "paused"
            } else if progress >= 1.0 {
                "completed"
            } else {
                "downloading"
            };
            (
                mapped,
                progress,
                number("dlspeed", "dlspeed")?,
                number("upspeed", "upspeed")?,
                number("total_size", "size")?,
                number("downloaded", "downloaded")?,
                number("uploaded", "uploaded")?,
            )
        } else {
            let progress = number("percentDone", "percent_done")?;
            let code = task["error"]
                .as_u64()
                .ok_or(AgentError::code("invalidResponse"))?;
            let status = task["status"]
                .as_u64()
                .filter(|n| *n <= 6)
                .ok_or(AgentError::code("invalidResponse"))?;
            let state = if code > 0 {
                "failed"
            } else if status == 0 {
                "paused"
            } else if progress >= 1.0 {
                "completed"
            } else {
                "downloading"
            };
            (
                state,
                progress,
                number("rateDownload", "rate_download")?,
                number("rateUpload", "rate_upload")?,
                number("totalSize", "total_size")?,
                number("downloadedEver", "downloaded_ever")?,
                number("uploadedEver", "uploaded_ever")?,
            )
        };
    if progress > 1.0
        || [total, downloaded, uploaded]
            .iter()
            .any(|n| *n > crate::protocol::MAX_INTEGER as f64 || n.fract() != 0.0)
    {
        return Err(AgentError::code("invalidResponse"));
    }
    Ok(
        json!({"state":state,"progress":progress,"downloadSpeed":down,"uploadSpeed":up,"totalBytes":total as u64,"downloadedBytes":downloaded as u64}),
    )
}

#[cfg(test)]
mod hash_tests {
    use super::*;
    #[test]
    fn full_info_hash_and_api_task_id_are_distinct() {
        let task = json!({"hash":"b".repeat(40),"infohash_v1":"a".repeat(40),"infohash_v2":"c".repeat(64)});
        assert!(matches_hash(&task, &"a".repeat(40)));
        assert!(matches_hash(&task, &"c".repeat(64)));
        assert!(!matches_hash(&task, &"c".repeat(40)));
        assert!(!matches_hash(&task, &"d".repeat(64)));
        let pure_v2 = json!({"hash":"c".repeat(40),"infohash_v2":"c".repeat(64)});
        assert!(!matches_hash(&pure_v2, &"c".repeat(40)));
        assert!(matches_hash(&pure_v2, &"c".repeat(64)));
    }
}
