use crate::{
    auth::Auth,
    config::Config,
    credentials::{private_directory, read_secret, FileCredentials},
    management_schema,
};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, Limited, StreamBody};
use hyper::{
    body::{Frame, Incoming},
    header, Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use popular_agent_core::{
    application::Agent,
    diagnostics::{self, Trace},
    errors::AgentError,
    queue,
    resource_sites::{ConfigureRequest, EnabledRequest, SiteRequest},
    settings::{GatewayRequest, TestRequest},
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    convert::Infallible, fs::File, future::Future, net::SocketAddr, path::Path, sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{watch, Semaphore},
    task::JoinSet,
};

type Body = UnsyncBoxBody<Bytes, Infallible>;
struct Failure {
    status: StatusCode,
    error: AgentError,
}
impl From<AgentError> for Failure {
    fn from(error: AgentError) -> Self {
        let status = match error.code {
            "managementUnauthorized" => StatusCode::UNAUTHORIZED,
            "managementForbidden" => StatusCode::FORBIDDEN,
            "managementRateLimited" => StatusCode::TOO_MANY_REQUESTS,
            "invalidSettings" | "invalidUrl" | "invalidSecret" | "invalidCommand"
            | "targetChanged" | "gatewayRequired" | "siteNotConfigured" => StatusCode::BAD_REQUEST,
            _ => StatusCode::BAD_GATEWAY,
        };
        Self { status, error }
    }
}
fn failure(status: StatusCode, code: &'static str) -> Failure {
    Failure {
        status,
        error: AgentError::code(code),
    }
}
fn body(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).boxed_unsync()
}
fn json_response(status: StatusCode, value: Value) -> Response<Body> {
    let mut response = Response::new(body(value.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    response
}
fn header_value(request: &Request<Incoming>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)?
        .to_str()
        .ok()
        .map(str::to_owned)
}
fn cookie(request: &Request<Incoming>) -> Option<String> {
    header_value(request, "cookie")?
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("agent_session=").map(str::to_owned))
}
async fn read_json<T: DeserializeOwned>(request: Request<Incoming>) -> Result<T, Failure> {
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_none_or(|h| h.split(';').next() != Some("application/json"))
    {
        return Err(failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalidSettings",
        ));
    }
    let bytes = tokio::time::timeout(
        Duration::from_secs(10),
        Limited::new(request.into_body(), 16384).collect(),
    )
    .await
    .map_err(|e| Failure {
        status: StatusCode::REQUEST_TIMEOUT,
        error: AgentError::caused("timeout", e),
    })?
    .map_err(|e| Failure {
        status: if e.is::<http_body_util::LengthLimitError>() {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::BAD_REQUEST
        },
        error: AgentError::caused("invalidSettings", std::io::Error::other(e)),
    })?
    .to_bytes();
    serde_json::from_slice(&bytes).map_err(|e| AgentError::caused("invalidSettings", e).into())
}
struct State {
    config: Config,
    agent: Arc<Agent<FileCredentials>>,
    auth: Arc<Auth>,
    login_work: Arc<Semaphore>,
    events: Arc<Semaphore>,
    stop: watch::Sender<bool>,
}
pub struct WebServer {
    state: Arc<State>,
    _data_lock: File,
}
impl WebServer {
    pub fn new(mut config: Config) -> Result<Self, AgentError> {
        config.validate()?;
        private_directory(&config.data)?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let data_lock = options.open(config.data.join(".agent.lock"))?;
        data_lock
            .try_lock()
            .map_err(|e| AgentError::caused("managementDataLocked", e))?;
        if !config.static_dir.join("index.html").is_file() {
            return Err(AgentError::code("managementAssetsMissing"));
        }
        let credential_dir = config.data.join("credentials");
        if (config.data.join("resource-sites.json").exists()
            || config.data.join("settings.json").exists()
            || config.data.join("identity.json").exists())
            && !credential_dir.join("key-check.json").exists()
        {
            return Err(AgentError::code("credentialError"));
        }
        let data_root = std::fs::canonicalize(&config.data)?;
        let static_root = std::fs::canonicalize(&config.static_dir)?;
        for secret in [&config.master_key, &config.admin_password] {
            let secret = std::fs::canonicalize(secret)?;
            if secret.starts_with(&data_root) || secret.starts_with(&static_root) {
                return Err(AgentError::code("invalidSettings"));
            }
        }
        if data_root.starts_with(&static_root) || static_root.starts_with(&data_root) {
            return Err(AgentError::code("invalidSettings"));
        }
        let store = FileCredentials::open(&credential_dir, &config.master_key)?;
        let mut password = read_secret(&config.admin_password, 4098)?;
        while matches!(password.last(), Some(b'\n' | b'\r')) {
            password.pop();
        }
        let auth = Arc::new(Auth::new(&password, config.session_ttl)?);
        password.fill(0);
        // Prove referenced credentials can be decrypted before exposing management or starting Core.
        let stored = popular_agent_core::storage::load(&config.data)?;
        popular_agent_core::storage::secrets(&stored, &store)?;
        let agent = Arc::new(Agent::new(config.data.clone(), store));
        Ok(Self {
            _data_lock: data_lock,
            state: Arc::new(State {
                config,
                agent,
                auth,
                login_work: Arc::new(Semaphore::new(1)),
                events: Arc::new(Semaphore::new(32)),
                stop: watch::channel(false).0,
            }),
        })
    }
    pub async fn serve(
        self,
        listener: TcpListener,
        shutdown: impl Future<Output = ()>,
    ) -> Result<(), AgentError> {
        let mut connections = JoinSet::new();
        let permits = Arc::new(Semaphore::new(64));
        let mut runtime = tokio::spawn(self.state.agent.clone().run());
        tokio::pin!(shutdown);
        let result = loop {
            tokio::select! {
                _ = &mut shutdown => break Ok(()),
                result = &mut runtime => break match result {
                    Ok(Err(error)) => Err(error),
                    Ok(Ok(())) => Err(AgentError::code("runtimeError")),
                    Err(error) => Err(AgentError::caused("runtimeError", error)),
                },
                Some(_) = connections.join_next(), if !connections.is_empty() => {},
                incoming = listener.accept() => {
                    let (socket, address) = match incoming { Ok(v) => v, Err(e) => break Err(e.into()) };
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                    let state = self.state.clone();
                    let mut stopping = state.stop.subscribe();
                    connections.spawn(async move {
                        let _permit = permit;
                        let service = hyper::service::service_fn(move |request| request_entry(state.clone(), address, request));
                        let connection = hyper::server::conn::http1::Builder::new()
                            .timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).keep_alive(false)
                            .serve_connection(TokioIo::new(socket), service);
                        tokio::pin!(connection);
                        tokio::select! {
                            result = &mut connection => { if let Err(error) = result {
                                diagnostics::failure("http.connection", "web", &AgentError::caused("networkError", error), 0);
                            } },
                            _ = stopping.changed() => {
                                connection.as_mut().graceful_shutdown();
                                let _ = tokio::time::timeout(Duration::from_secs(5), connection).await;
                            }
                        }
                    });
                }
            }
        };
        self.state.stop.send_replace(true);
        self.state.agent.shutdown();
        if !runtime.is_finished() {
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut runtime).await;
        }
        runtime.abort();
        let _ = tokio::time::timeout(Duration::from_secs(6), async {
            while connections.join_next().await.is_some() {}
        })
        .await;
        connections.abort_all();
        result
    }
}
async fn request_entry(
    state: Arc<State>,
    address: SocketAddr,
    request: Request<Incoming>,
) -> Result<Response<Body>, Infallible> {
    let trace = Trace::with_id(
        header_value(&request, "x-request-id")
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
    );
    trace.stage("http.request.started");
    let mut response = match dispatch(state, address, request, &trace).await {
        Ok(response) => {
            trace.stage("http.request.completed");
            response
        }
        Err(failure) => {
            trace.failed(&failure.error);
            json_response(
                failure.status,
                json!({"error":{"code":failure.error.code},"correlationId":trace.id}),
            )
        }
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        "x-content-type-options",
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", header::HeaderValue::from_static("DENY"));
    headers.insert(
        "referrer-policy",
        header::HeaderValue::from_static("no-referrer"),
    );
    headers.insert("content-security-policy", header::HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    headers.insert(
        "x-request-id",
        header::HeaderValue::from_str(&trace.id).unwrap(),
    );
    Ok(response)
}
async fn dispatch(
    state: Arc<State>,
    address: SocketAddr,
    request: Request<Incoming>,
    trace: &Trace,
) -> Result<Response<Body>, Failure> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if method == Method::GET && matches!(path.as_str(), "/health/live" | "/health/ready") {
        return Ok(json_response(StatusCode::OK, json!({"status":"ok"})));
    }
    if header_value(&request, "host").as_deref() != Some(&state.config.authority)
        || header_value(&request, "origin").is_some_and(|o| o != state.config.origin)
        || header_value(&request, "sec-fetch-site").as_deref() == Some("cross-site")
    {
        return Err(failure(StatusCode::FORBIDDEN, "managementForbidden"));
    }
    if !matches!(method, Method::GET | Method::HEAD)
        && header_value(&request, "origin").as_deref() != Some(&state.config.origin)
    {
        return Err(failure(StatusCode::FORBIDDEN, "managementForbidden"));
    }
    if !path.starts_with("/api/") {
        return static_response(&state.config.static_dir, &path, method).await;
    }
    if request.uri().query().is_some() {
        return Err(failure(StatusCode::BAD_REQUEST, "invalidSettings"));
    }
    let token = cookie(&request).unwrap_or_default();
    if path == "/api/session" && method == Method::POST {
        trace.stage("management.login.started");
        if !state.auth.allow_login(address.ip()) {
            return Err(failure(
                StatusCode::TOO_MANY_REQUESTS,
                "managementRateLimited",
            ));
        }
        let login: management_schema::Login = read_json(request).await?;
        let permit = state
            .login_work
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure(StatusCode::TOO_MANY_REQUESTS, "managementRateLimited"))?;
        let auth = state.auth.clone();
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            auth.verifier.verify(login.password.as_bytes())
        })
        .await
        .map_err(|e| AgentError::caused("runtimeError", e))?;
        if !valid {
            return Err(failure(StatusCode::UNAUTHORIZED, "managementUnauthorized"));
        }
        trace.stage("management.login.verified");
        let (token, session) = state.auth.create()?;
        let mut response = json_response(
            StatusCode::OK,
            json!({"authenticated":true,"csrf":session.csrf,"version":env!("CARGO_PKG_VERSION")}),
        );
        set_cookie(
            &mut response,
            &state.config,
            &token,
            state.auth.ttl.as_secs(),
        );
        return Ok(response);
    }
    if path == "/api/session" && method == Method::GET {
        trace.stage("management.session.read");
        return Ok(json_response(
            StatusCode::OK,
            match state.auth.session(&token) {
                Some(s) => {
                    json!({"authenticated":true,"csrf":s.csrf,"version":env!("CARGO_PKG_VERSION")})
                }
                None => json!({"authenticated":false,"version":env!("CARGO_PKG_VERSION")}),
            },
        ));
    }
    let session = state
        .auth
        .session(&token)
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "managementUnauthorized"))?;
    if !matches!(method, Method::GET | Method::HEAD)
        && header_value(&request, "x-csrf-token").as_deref() != Some(&session.csrf)
    {
        return Err(failure(StatusCode::FORBIDDEN, "managementForbidden"));
    }
    trace.stage("management.session.authorized");
    let value = match (method, path.as_str()) {
        (Method::DELETE, "/api/session") => {
            trace.stage("management.session.logout.started");
            state.auth.remove(&token);
            let mut response = json_response(StatusCode::OK, json!({"authenticated":false}));
            set_cookie(&mut response, &state.config, "", 0);
            return Ok(response);
        }
        (Method::GET, "/api/resource-sites") => {
            trace.stage("resource-sites.list.started");
            serde_json::to_value(state.agent.resource_sites.list(trace).await?)
                .map_err(AgentError::from)?
        }
        (Method::POST, "/api/resource-sites/configure") => {
            let input: ConfigureRequest = read_json(request).await?;
            serde_json::to_value(state.agent.resource_sites.configure(input, trace).await?)
                .map_err(AgentError::from)?
        }
        (Method::POST, "/api/resource-sites/verify") => {
            let input: SiteRequest = read_json(request).await?;
            serde_json::to_value(state.agent.resource_sites.verify(input.site, trace).await?)
                .map_err(AgentError::from)?
        }
        (Method::PUT, "/api/resource-sites/enabled") => {
            let input: EnabledRequest = read_json(request).await?;
            serde_json::to_value(state.agent.resource_sites.set_enabled(input, trace).await?)
                .map_err(AgentError::from)?
        }
        (Method::POST, "/api/resource-sites/remove") => {
            let input: SiteRequest = read_json(request).await?;
            state.agent.resource_sites.remove(input.site, trace).await?;
            json!({"ok":true})
        }
        (Method::GET, "/api/settings") => {
            trace.stage("management.settings.load.started");
            serde_json::to_value(state.agent.load_settings().await?).map_err(AgentError::from)?
        }
        (Method::GET, "/api/runtime") => runtime_value(&state),
        (Method::POST, "/api/gateway/connect") => {
            let input: GatewayRequest = read_json(request).await?;
            serde_json::to_value(state.agent.connect_device(input, trace).await?)
                .map_err(AgentError::from)?
        }
        (Method::POST, "/api/gateway/disconnect") => {
            trace.stage("management.gateway.disconnect.started");
            state.agent.disconnect_gateway().await?;
            json!({"ok":true})
        }
        (Method::POST, "/api/downloader/test") => {
            let input: TestRequest = read_json(request).await?;
            serde_json::to_value(state.agent.test_downloader(input, trace).await?)
                .map_err(AgentError::from)?
        }
        (Method::POST, "/api/downloader/reset") => {
            trace.stage("management.downloader.reset.started");
            serde_json::to_value(state.agent.reset_downloader(trace).await?)
                .map_err(AgentError::from)?
        }
        (Method::PUT, "/api/locale") => {
            trace.stage("management.locale.save.started");
            let input: management_schema::Locale = read_json(request).await?;
            state.agent.save_locale(input.locale).await?;
            json!({"ok":true})
        }
        (Method::GET, "/api/queue") => {
            trace.stage("management.queue.load.started");
            serde_json::to_value(queue::view(&state.agent.directory, &state.agent.runtime))
                .map_err(AgentError::from)?
        }
        (Method::PUT, "/api/queue/page") => {
            trace.stage("management.queue.page.started");
            let input: management_schema::QueuePage = read_json(request).await?;
            queue::page(&state.agent.runtime, input.cursor)?;
            json!({"ok":true})
        }
        (Method::GET, "/api/events") => return events(state, token),
        _ => return Err(failure(StatusCode::NOT_FOUND, "invalidCommand")),
    };
    Ok(json_response(StatusCode::OK, value))
}
fn set_cookie(response: &mut Response<Body>, config: &Config, token: &str, max_age: u64) {
    let cookie = format!(
        "agent_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if config.secure_cookie { "; Secure" } else { "" }
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        header::HeaderValue::from_str(&cookie).unwrap(),
    );
}
fn runtime_value(state: &State) -> Value {
    let mut value =
        serde_json::to_value(state.agent.runtime.snapshot()).expect("runtime snapshot serializes");
    value["preferenceError"] = Value::Null;
    value
}
fn events(state: Arc<State>, token: String) -> Result<Response<Body>, Failure> {
    let permit = state
        .events
        .clone()
        .try_acquire_owned()
        .map_err(|_| failure(StatusCode::TOO_MANY_REQUESTS, "managementRateLimited"))?;
    let receiver = state.agent.runtime.subscribe();
    let stop = state.stop.subscribe();
    let stream = stream::unfold(
        (state, token, receiver, stop, permit, true, false),
        |(state, token, mut receiver, mut stop, permit, first, ended)| async move {
            if ended || *stop.borrow() {
                return None;
            }
            if !first {
                tokio::select! { _=receiver.recv()=>{}, _=tokio::time::sleep(Duration::from_secs(10))=>{}, _=stop.changed()=>return None }
            }
            let expired = state.auth.session(&token).is_none();
            let event = if expired {
                "event: session-expired\ndata: {}\n\n".to_owned()
            } else {
                format!("event: runtime\ndata: {}\n\n", runtime_value(&state))
            };
            Some((
                Ok::<_, Infallible>(Frame::data(Bytes::from(event))),
                (state, token, receiver, stop, permit, false, expired),
            ))
        },
    );
    let mut response = Response::new(StreamBody::new(stream).boxed_unsync());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert("x-accel-buffering", header::HeaderValue::from_static("no"));
    Ok(response)
}
async fn static_response(
    root: &Path,
    path: &str,
    method: Method,
) -> Result<Response<Body>, Failure> {
    if !matches!(method, Method::GET | Method::HEAD) {
        return Err(failure(StatusCode::METHOD_NOT_ALLOWED, "invalidCommand"));
    }
    if path.contains(['%', '\\', '\0']) || path.split('/').any(|part| part == "..") {
        return Err(failure(StatusCode::BAD_REQUEST, "invalidSettings"));
    }
    let relative = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    if relative != "index.html" && !relative.starts_with("assets/") {
        return Err(failure(StatusCode::NOT_FOUND, "invalidCommand"));
    }
    let root = tokio::fs::canonicalize(root)
        .await
        .map_err(AgentError::from)?;
    let file = tokio::fs::canonicalize(root.join(relative))
        .await
        .map_err(|_| failure(StatusCode::NOT_FOUND, "invalidCommand"))?;
    if !file.starts_with(&root) {
        return Err(failure(StatusCode::FORBIDDEN, "managementForbidden"));
    }
    let metadata = tokio::fs::metadata(&file).await.map_err(AgentError::from)?;
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err(failure(StatusCode::NOT_FOUND, "invalidCommand"));
    }
    let content_type = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    let bytes = if method == Method::HEAD {
        Vec::new()
    } else {
        tokio::fs::read(file).await.map_err(AgentError::from)?
    };
    let mut response = Response::new(body(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(content_type),
    );
    Ok(response)
}

pub fn initialize(directory: &Path) -> Result<(), AgentError> {
    crate::credentials::initialize_secrets(directory)
}
