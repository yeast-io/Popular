//! Fixed endpoint labels and URL origins only: no credentials, query strings or arbitrary paths.
use super::types::Site;
use crate::{diagnostics::Trace, errors::AgentError};
use reqwest::{
    cookie::{CookieStore, Jar},
    header::{CONTENT_LENGTH, CONTENT_TYPE, COOKIE, LOCATION, SET_COOKIE, TRANSFER_ENCODING},
    Method, RequestBuilder, Response,
};
use serde_json::json;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use url::Url;

pub(super) const MAX_REDIRECTS: usize = 5;

fn target(
    current: &Url,
    location: Option<&str>,
    origin: &url::Origin,
    credentialed: bool,
) -> Result<Url, AgentError> {
    let location = location
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AgentError::code("siteRedirected"))?;
    let next = current
        .join(location)
        .map_err(|e| AgentError::caused("siteRedirected", e))?;
    let development = (cfg!(test)
        || std::env::var("HELPER_ALLOW_INSECURE_DEV").as_deref() == Ok("true"))
        && current.scheme() == "http"
        && next.origin() == *origin
        && matches!(
            current.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]")
        );
    if (next.scheme() != "https" && !development)
        || !next.username().is_empty()
        || next.password().is_some()
        || next.fragment().is_some()
        || (credentialed && next.origin() != *origin)
    {
        return Err(AgentError::code("siteRedirected"));
    }
    let path = next.path().to_ascii_lowercase();
    if ["login", "verify", "captcha"]
        .iter()
        .any(|value| path.contains(value))
    {
        return Err(AgentError::code("siteAuthentication"));
    }
    Ok(next)
}

fn endpoint(url: &Url) -> &'static str {
    match url.path() {
        "/" => "/",
        "/index.php" => "/index.php",
        "/login.php" => "/login.php",
        "/login" => "/login",
        "/torrents.php" => "/torrents.php",
        "/details.php" => "/details.php",
        "/download.php" => "/download.php",
        "/api/member/profile" => "/api/member/profile",
        "/api/torrent/search" => "/api/torrent/search",
        "/api/torrent/detail" => "/api/torrent/detail",
        "/api/torrent/genDlToken" => "/api/torrent/genDlToken",
        "/api/v1/user/profile" => "/api/v1/user/profile",
        "/api/v1/torrents/search" => "/api/v1/torrents/search",
        "/api/v1/torrents/detail" => "/api/v1/torrents/detail",
        "/api/v1/torrents" => "/api/v1/torrents",
        "/api/v1/torrents/genDlToken" => "/api/v1/torrents/genDlToken",
        path if path.strip_prefix("/api/v1/torrents/").is_some_and(|id| {
            !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())
        }) =>
        {
            "/api/v1/torrents/:id"
        }
        _ => "<redacted>",
    }
}

pub(super) async fn send(
    request: RequestBuilder,
    site: Site,
    trace: &Trace,
    stage: &str,
) -> Result<Response, AgentError> {
    let (client, request) = request.build_split();
    let mut request = request?;
    let origin = request.url().origin();
    let credentialed =
        request.headers().contains_key(COOKIE) || request.headers().contains_key("x-api-key");
    let cookies = request.headers().get(COOKIE).cloned();
    let jar = Jar::default();
    if let Some(cookie) = &cookies {
        for pair in cookie
            .to_str()
            .map_err(|e| AgentError::caused("siteInvalidResponse", e))?
            .split(';')
        {
            jar.add_cookie_str(
                &format!(
                    "{}; Path=/{}",
                    pair.trim(),
                    if request.url().scheme() == "https" {
                        "; Secure"
                    } else {
                        ""
                    }
                ),
                request.url(),
            );
        }
    }
    let started = Instant::now();
    let budget = request
        .timeout()
        .copied()
        .unwrap_or(Duration::from_secs(15));
    let mut visited = HashSet::new();
    for redirects in 0..=MAX_REDIRECTS {
        let url = request.url().clone();
        if !visited.insert(url.as_str().to_owned()) {
            return Err(AgentError::code("siteRedirected"));
        }
        let remaining = budget
            .checked_sub(started.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| AgentError::code("siteTimeout"))?;
        *request.timeout_mut() = Some(remaining);
        if cookies.is_some() && redirects > 0 {
            request.headers_mut().remove(COOKIE);
            if let Some(value) = jar.cookies(&url) {
                request.headers_mut().insert(COOKIE, value);
            }
        }
        trace.context(json!({
        "site":site.id(), "httpMethod":request.method().as_str(),
        "requestOrigin":url.origin().ascii_serialization(), "endpoint":endpoint(&url),
        "httpStatus":null, "redirectOrigin":null, "redirectEndpoint":null,
        "redirectSameOrigin":null, "redirectLocationPresent":false, "httpDurationMs":null, "redirectCount":redirects
    }));
        trace.stage(stage);
        let attempt = request
            .try_clone()
            .ok_or_else(|| AgentError::code("siteInvalidResponse"))?;
        let hop_started = Instant::now();
        let result = client.execute(attempt).await;
        trace.context(json!({"httpDurationMs":hop_started.elapsed().as_millis()}));
        let response = result.map_err(|error| {
            AgentError::caused(
                if error.is_timeout() {
                    "siteTimeout"
                } else {
                    "siteRemoteError"
                },
                error.without_url(),
            )
        })?;
        if cookies.is_some() {
            jar.set_cookies(&mut response.headers().get_all(SET_COOKIE).iter(), &url);
        }
        let location = response.headers().get(LOCATION);
        let diagnostic_target = location
            .and_then(|v| v.to_str().ok())
            .and_then(|v| url.join(v).ok())
            .filter(|v| matches!(v.scheme(), "http" | "https"));
        trace.context(json!({
            "httpStatus":response.status().as_u16(),
            "redirectLocationPresent":location.is_some(),
            "redirectOrigin":diagnostic_target.as_ref().map(|v| v.origin().ascii_serialization()),
            "redirectEndpoint":diagnostic_target.as_ref().map(endpoint),
            "redirectSameOrigin":diagnostic_target.as_ref().map(|v| v.origin() == url.origin())
        }));
        if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        let status = response.status().as_u16();
        if redirects == MAX_REDIRECTS {
            return Err(AgentError::code("siteRedirected").http(status));
        }
        let next = target(
            &url,
            location.and_then(|v| v.to_str().ok()),
            &origin,
            credentialed,
        )
        .map_err(|e| e.http(status))?;
        trace.stage("resource-sites.http.redirect");
        if status == 303 && request.method() != Method::HEAD
            || matches!(status, 301 | 302) && request.method() == Method::POST
        {
            *request.method_mut() = Method::GET;
            *request.body_mut() = None;
            request.headers_mut().remove(CONTENT_TYPE);
            request.headers_mut().remove(CONTENT_LENGTH);
            request.headers_mut().remove(TRANSFER_ENCODING);
        }
        *request.url_mut() = next;
        drop(response);
    }
    Err(AgentError::code("siteRedirected"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn server(
        responses: Vec<(u16, String, String)>,
    ) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, headers, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 8192];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let size = header
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + size {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        (base, task)
    }

    #[tokio::test]
    async fn follows_five_hops_but_never_sends_a_seventh_request() {
        for mode in ["cookie", "api", "download"] {
            for hops in [5, 6] {
                let mut responses = (0..hops)
                    .map(|n| {
                        (
                            302,
                            format!(
                                "Location: /hop-{n}\r\nSet-Cookie: session=ROTATED; Path=/\r\n"
                            ),
                            String::new(),
                        )
                    })
                    .collect::<Vec<_>>();
                if hops == 5 {
                    responses.push((200, String::new(), "torrent".into()));
                }
                let (base, server) = server(responses).await;
                let trace = Trace::with_id("five-hop-test".into());
                let mut request = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .no_proxy()
                    .build()
                    .unwrap()
                    .get(base.clone());
                request = match mode {
                    "cookie" => request.header(COOKIE, "uid=PRIVATE; session=OLD"),
                    "api" => request.header("x-api-key", "PRIVATE_KEY"),
                    _ => request,
                };
                let result = send(request, Site::Hdwing, &trace, "redirect.http.started").await;
                if hops == 5 {
                    assert_eq!(result.unwrap().bytes().await.unwrap().as_ref(), b"torrent");
                } else {
                    let error = result.unwrap_err();
                    assert_eq!(error.code, "siteRedirected");
                    let record = trace.failure_record(&error);
                    assert_eq!(record["redirectCount"], 5);
                    assert!(!record.to_string().contains("PRIVATE"));
                }
                let requests = server.await.unwrap();
                assert_eq!(requests.len(), 6);
                for (n, request) in requests.iter().enumerate() {
                    match mode {
                        "cookie" => {
                            assert!(request.contains("uid=PRIVATE"));
                            assert!(request.contains(if n == 0 {
                                "session=OLD"
                            } else {
                                "session=ROTATED"
                            }));
                        }
                        "api" => {
                            assert!(request.contains("x-api-key: PRIVATE_KEY"));
                            assert!(!request.contains("cookie:"));
                        }
                        _ => {
                            assert!(!request.contains("cookie:"));
                            assert!(!request.contains("x-api-key:"));
                        }
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn redirect_status_controls_method_and_body_replay() {
        for status in [301, 302, 303, 307, 308] {
            let (base, server) = server(vec![
                (status, "Location: /next\r\n".into(), String::new()),
                (200, String::new(), "ok".into()),
            ])
            .await;
            let request = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .unwrap()
                .post(base)
                .header("x-api-key", "PRIVATE_KEY")
                .json(&json!({"id":"42"}));
            send(request, Site::Mteam, &Trace::new(), "redirect.http.started")
                .await
                .unwrap();
            let requests = server.await.unwrap();
            assert!(requests[1].contains("x-api-key: PRIVATE_KEY"));
            if matches!(status, 307 | 308) {
                assert!(requests[1].starts_with("POST /next "));
                assert!(requests[1].ends_with("{\"id\":\"42\"}"));
            } else {
                assert!(requests[1].starts_with("GET /next "));
                assert!(!requests[1].contains("content-type:"));
                assert!(!requests[1].contains("{\"id\""));
            }
        }
    }

    #[test]
    fn redirect_targets_restrict_credentials_but_allow_credential_free_https_cdn() {
        let base = Url::parse("https://site.example/start").unwrap();
        let origin = base.origin();
        assert!(target(&base, Some("https://cdn.example/file"), &origin, false).is_ok());
        assert_eq!(
            target(&base, Some("https://cdn.example/file"), &origin, true)
                .unwrap_err()
                .code,
            "siteRedirected"
        );
        for location in [
            None,
            Some(""),
            Some("http://site.example/file"),
            Some("https://user:PRIVATE@site.example/file"),
            Some("/file#PRIVATE"),
            Some("file:///tmp/file"),
        ] {
            assert_eq!(
                target(&base, location, &origin, false).unwrap_err().code,
                "siteRedirected"
            );
        }
        for location in ["/login.php", "/verify", "/captcha"] {
            assert_eq!(
                target(&base, Some(location), &origin, true)
                    .unwrap_err()
                    .code,
                "siteAuthentication"
            );
        }
    }

    #[tokio::test]
    async fn redirects_share_one_deadline_instead_of_resetting_the_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            for n in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let count = socket.read(&mut bytes).await.unwrap();
                assert!(count > 0);
                tokio::time::sleep(Duration::from_millis(90)).await;
                let response = if n == 0 {
                    "HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                };
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let request = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
            .get(base)
            .timeout(Duration::from_millis(150));
        let error = send(request, Site::Mteam, &Trace::new(), "redirect.http.started")
            .await
            .unwrap_err();
        assert_eq!(error.code, "siteTimeout");
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn rejects_loops_and_missing_locations_without_another_request() {
        for headers in ["Location: /\r\n", ""] {
            let (base, server) = server(vec![(302, headers.into(), String::new())]).await;
            let request = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .unwrap()
                .get(base);
            assert_eq!(
                send(request, Site::Mteam, &Trace::new(), "redirect.http.started")
                    .await
                    .unwrap_err()
                    .code,
                "siteRedirected"
            );
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }
    #[test]
    fn arbitrary_paths_are_never_logged() {
        assert_eq!(
            endpoint(&Url::parse("https://site.example/SECRET?passkey=SECRET").unwrap()),
            "<redacted>"
        );
        assert_eq!(
            endpoint(&Url::parse("https://site.example/login.php?token=SECRET").unwrap()),
            "/login.php"
        );
    }
}
