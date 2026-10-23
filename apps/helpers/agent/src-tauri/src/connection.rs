use crate::{
    diagnostics::Trace,
    errors::AgentError,
    journal::{self, Identity},
    protocol::{self, Clock, Context, DeviceKeys, Wire},
    runtime::{BindingState, Runtime},
    settings::{self, Secrets, Settings},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
pub fn client() -> Result<reqwest::Client, AgentError> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?)
}
fn base(settings: &Settings) -> Result<url::Url, AgentError> {
    let mut url = settings::endpoint(&settings.gateway_url, true)?;
    url.set_scheme(if matches!(url.scheme(), "https" | "wss") {
        "https"
    } else {
        "http"
    })
    .map_err(|_| AgentError::code("invalidUrl"))?;
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url)
}
async fn signing_keys(base: &url::Url, key: &str, trace: &Trace) -> Result<Value, AgentError> {
    trace.stage("gateway.signing-keys.started");
    let response = client()?
        .get(
            base.join("client/v1/signing-keys")
                .map_err(|_| AgentError::code("invalidUrl"))?,
        )
        .bearer_auth(key)
        .send()
        .await?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(AgentError::code(match status {
            401 | 403 | 410 => "rebindRequired",
            404 => "gatewayProtocol",
            _ => "gatewayUnavailable",
        })
        .http(status));
    }
    let bytes = crate::downloader::body(response).await?;
    let keys: Value =
        serde_json::from_slice(&bytes).map_err(|e| AgentError::caused("invalidResponse", e))?;
    if keys["keys"]
        .as_array()
        .is_none_or(|keys| keys.is_empty() || keys.len() > 32)
    {
        return Err(AgentError::code("invalidResponse"));
    }
    trace.stage("gateway.signing-keys.completed");
    Ok(keys)
}
fn network(error: tokio_tungstenite::tungstenite::Error) -> AgentError {
    AgentError::caused("networkError", error)
}
async fn send(socket: &mut Socket, wire: &Wire) -> Result<(), AgentError> {
    let text = serde_json::to_string(wire)?;
    if text.len() > 65536 {
        return Err(protocol::invalid());
    }
    tokio::time::timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| AgentError::code("timeout"))?
    .map_err(network)
}
async fn receive(socket: &mut Socket) -> Result<Wire, AgentError> {
    loop {
        let frame = socket
            .next()
            .await
            .ok_or(AgentError::code("networkError"))?
            .map_err(network)?;
        match frame {
            Message::Text(text) => {
                let wire = protocol::wire(&text)?;
                if wire.command == "__error__" {
                    return Err(remote_error(&wire)?);
                }
                if wire.command == "__session_revoked__" {
                    let error = remote_error(&wire)?;
                    if error.gateway_code.as_deref() != Some("SESSION_REVOKED") {
                        return Err(protocol::invalid());
                    }
                    return Err(error);
                }
                return Ok(wire);
            }
            Message::Ping(bytes) => {
                socket.send(Message::Pong(bytes)).await.map_err(network)?;
            }
            Message::Pong(_) => {}
            Message::Close(_) => return Err(AgentError::code("networkError")),
            _ => return Err(protocol::invalid()),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteError {
    code: String,
}
pub fn remote_error(wire: &Wire) -> Result<AgentError, AgentError> {
    let error: RemoteError = protocol::parse(&wire.payload)?;
    if error.code.is_empty()
        || error.code.len() > 100
        || !error
            .code
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    {
        return Err(protocol::invalid());
    }
    Ok(AgentError::gateway(&error.code))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    challenge: String,
    expires_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChallengeText {
    protocol_version: u8,
    command: String,
    audience: String,
    connection_id: String,
    nonce: String,
    owner_id: String,
    auth_version: u64,
    keys_digest: String,
    intent: String,
    operation_id: Option<String>,
    device_id: Option<String>,
    device_version: Option<u64>,
    expires_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authenticated {
    authenticated: bool,
    owner_id: String,
    device_id: String,
    auth_version: u64,
    device_version: u64,
    session_id: String,
    instance_id: String,
    server_time: u64,
}
async fn authenticate(
    socket: &mut Socket,
    identity: &Identity,
    keys: &DeviceKeys,
    trace: &Trace,
) -> Result<(Context, Clock), AgentError> {
    trace.stage("gateway.authenticate.started");
    let public = keys.public()?;
    let mut payload = json!({"intent":if identity.device_id.is_some() {"authenticate"} else {"bind"},"keys":public});
    if let Some(id) = &identity.device_id {
        payload["deviceId"] = json!(id);
    } else {
        payload["operationId"] = json!(identity.installation_id);
    }
    let auth = protocol::message("__authenticate__", payload, None);
    send(socket, &auth).await?;
    let wire = receive(socket).await?;
    if wire.command != "__auth_challenge__" || wire.reply_to.as_deref() != Some(&auth.message_id) {
        return Err(protocol::invalid());
    }
    let challenge: Challenge = protocol::parse(&wire.payload)?;
    let text: ChallengeText = serde_json::from_str(&challenge.challenge)
        .map_err(|e| AgentError::caused("invalidResponse", e))?;
    if text.protocol_version != 1
        || text.command != "__auth_proof__"
        || text.audience != "popular-helper-gateway"
        || !protocol::id(&text.connection_id)
        || !protocol::id(&text.owner_id)
        || !protocol::positive(text.auth_version)
        || text.keys_digest != protocol::fingerprint(&public)
        || protocol::decode(&text.nonce)?.len() != 32
        || text.expires_at != challenge.expires_at
        || !protocol::positive(text.expires_at)
        || text.intent != auth.payload["intent"].as_str().unwrap_or("")
        || text.device_id != identity.device_id
        || (identity.device_id.is_none()
            && (text.operation_id.as_ref() != Some(&identity.installation_id)
                || text.device_version.is_some()))
        || (identity.device_id.is_some()
            && (text.operation_id.is_some()
                || !text.device_version.is_some_and(protocol::positive)))
    {
        return Err(protocol::invalid());
    }
    // Sign the exact challenge string, including its original whitespace and property order.
    let mut proof = protocol::message(
        "__auth_proof__",
        json!({"proof":keys.proof(&challenge.challenge)?}),
        None,
    );
    proof.reply_to = Some(wire.message_id);
    let sent = Instant::now();
    send(socket, &proof).await?;
    let result = receive(socket).await?;
    if result.command != "__auth_result__" || result.reply_to.as_deref() != Some(&proof.message_id)
    {
        return Err(protocol::invalid());
    }
    let result: Authenticated = protocol::parse(&result.payload)?;
    let context = Context {
        owner_id: result.owner_id,
        device_id: result.device_id,
        auth_version: result.auth_version,
        device_version: result.device_version,
        session_id: result.session_id,
        instance_id: result.instance_id,
    };
    if !result.authenticated
        || !context.valid()
        || context.owner_id != text.owner_id
        || context.auth_version != text.auth_version
        || identity
            .device_id
            .as_ref()
            .is_some_and(|id| id != &context.device_id)
        || text
            .device_version
            .is_some_and(|v| v != context.device_version)
        || !protocol::positive(result.server_time)
        || result.server_time > text.expires_at
    {
        return Err(protocol::invalid());
    }
    // Add the full proof round-trip as a conservative upper bound; never extend a deadline with local wall time.
    let clock = Clock {
        server_ms: result
            .server_time
            .saturating_add(sent.elapsed().as_millis() as u64),
        anchor: Instant::now(),
        wall_anchor: std::time::SystemTime::now(),
    };
    trace.stage("gateway.authenticate.completed");
    Ok((context, clock))
}

pub async fn session_transport(
    directory: &Path,
    lock: &tokio::sync::Mutex<()>,
    runtime: &Runtime,
    settings: Settings,
    secrets: Secrets,
    mut identity: Identity,
    keys: DeviceKeys,
) -> Result<(), AgentError> {
    let trace = Trace::new();
    let action = async {
        if runtime.suspended.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        runtime.update(Some("connecting"), None, None);
        let base = base(&settings)?;
        let jwks = signing_keys(&base, &secrets.api_key, &trace).await?;
        trace.stage("gateway.socket.connect.started");
        let mut url = base
            .join("client/v1/socket")
            .map_err(|_| AgentError::code("invalidUrl"))?;
        url.set_scheme(if base.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| AgentError::code("invalidUrl"))?;
        let mut request = url.as_str().into_client_request().map_err(network)?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", secrets.api_key)
                .parse()
                .map_err(|_| AgentError::code("invalidSecret"))?,
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(65536))
            .max_frame_size(Some(65536));
        let connected = tokio::time::timeout(
            Duration::from_secs(10),
            connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| AgentError::code("timeout"))?;
        let (mut socket, _) = match connected {
            Ok(v) => v,
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                return Err(AgentError::code(match response.status().as_u16() {
                    401 | 403 | 410 => "rebindRequired",
                    404 => "gatewayProtocol",
                    _ => "gatewayUnavailable",
                })
                .http(response.status().as_u16()))
            }
            Err(error) => return Err(network(error)),
        };
        if identity.device_id.is_none() {
            runtime.set_binding(BindingState::Binding, None);
        }
        runtime.update(Some("connecting"), None, None);
        let (context, clock) = tokio::time::timeout(
            Duration::from_secs(9),
            authenticate(&mut socket, &identity, &keys, &trace),
        )
        .await
        .map_err(|_| AgentError::code("timeout"))??;
        let target = {
            let _guard = lock.lock().await;
            let current: Identity = journal::load(directory, "identity.json")?;
            if current.credential_id != identity.credential_id
                || current.gateway != identity.gateway
            {
                return Ok(());
            }
            identity.device_id = Some(context.device_id.clone());
            identity.binding_requested = false;
            journal::atomic(directory, "identity.json", &identity)?;
            crate::device::target(directory, &settings)?
        };
        {
            let mut state = runtime.queue.lock().unwrap_or_else(|e| e.into_inner());
            if state
                .cache
                .as_ref()
                .is_some_and(|cache| !crate::queue::same_binding(cache, &context))
            {
                state.cache = None;
                state.cursor = None;
            }
        }
        runtime.set_binding(BindingState::Bound, Some(context.device_id.clone()));
        runtime.update(Some("online"), None, None);
        trace.stage("gateway.session.authenticated");
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut outbound) = tokio::sync::mpsc::channel::<Wire>(128);
        let (incoming, inbound) = tokio::sync::mpsc::channel::<Wire>(128);
        let io = async {
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_pong = Instant::now();
            let mut queue_request: Option<String> = None;
            loop {
                let frame = tokio::select! {
                    _=runtime.changed.notified()=>{
                        let current = crate::storage::load(directory)?.settings;
                        // Revoke availability on the authenticated connection before switching sessions.
                        let configured=current.downloader_configured && crate::settings::same_downloader(&current,&settings);
                        let report=protocol::message("__agent_status__",json!({"downloaderType":target.downloader_type,"instanceId":target.instance_id,"configured":configured,"reachable":false}),Some(trace.id.clone()));
                        tokio::time::timeout(Duration::from_secs(5),sink.send(Message::Text(serde_json::to_string(&report)?.into()))).await.map_err(|_|AgentError::code("timeout"))?.map_err(network)?;
                        return Ok(());
                    },
                    _=runtime.queue_refresh.notified()=>{
                        let cursor=runtime.queue.lock().unwrap_or_else(|e|e.into_inner()).cursor.clone();
                        let payload=cursor.map_or_else(||json!({}),|v|json!({"cursor":v}));
                        let request=protocol::message("__queue_request__",payload,Some(trace.id.clone()));
                        queue_request=Some(request.message_id.clone());
                        Message::Text(serde_json::to_string(&request)?.into())
                    },
                    _=heartbeat.tick()=>{
                        let cursor=runtime.queue.lock().unwrap_or_else(|e|e.into_inner()).cursor.clone();
                        let payload=cursor.map_or_else(||json!({}),|v|json!({"cursor":v}));
                        let request=protocol::message("__queue_request__",payload,Some(trace.id.clone()));
                        queue_request=Some(request.message_id.clone());
                        tokio::time::timeout(Duration::from_secs(5),sink.send(Message::Text(serde_json::to_string(&request)?.into()))).await.map_err(|_|AgentError::code("timeout"))?.map_err(network)?;
                        if last_pong.elapsed()>Duration::from_secs(45) {return Err(AgentError::code("timeout"));} Message::Ping(Vec::new().into())},
                    message=outbound.recv()=>{
                        let Some(wire)=message else {return Ok(());};
                        let text=serde_json::to_string(&wire)?;
                        if text.len()>65536 {return Err(protocol::invalid());}
                        Message::Text(text.into())
                    },
                    message=stream.next()=>{
                        let frame=message.ok_or(AgentError::code("networkError"))?.map_err(network)?;
                        match frame {
                            Message::Ping(bytes)=>Message::Pong(bytes),
                            Message::Pong(_)=>{last_pong=Instant::now();continue;},
                            Message::Text(text)=>{
                                let wire=protocol::wire(&text)?;
                                if wire.command=="__session_revoked__" {let error=remote_error(&wire)?;if error.gateway_code.as_deref()!=Some("SESSION_REVOKED") {return Err(protocol::invalid());}return Err(error);}
                                if wire.command=="__error__" {
                                    let error=remote_error(&wire)?;
                                    if matches!(error.code,"rebindRequired"|"sessionRevoked") {return Err(error);}
                                }
                                if wire.command=="__queue_snapshot__" {
                                    if queue_request.is_none() || wire.reply_to.as_ref()!=queue_request.as_ref() || wire.correlation_id.as_deref()!=Some(&trace.id) {continue;}
                                    queue_request=None;
                                    let _guard=lock.lock().await;
                                    crate::queue::accept(directory,runtime,&identity,&context,&wire.payload)?;
                                    trace.stage("queue.snapshot.received");
                                    continue;
                                }
                                if wire.command=="__error__" && queue_request.is_some() && wire.reply_to.as_ref()==queue_request.as_ref() {
                                    queue_request=None;
                                    crate::diagnostics::failure("queue.snapshot",&trace.id,&remote_error(&wire)?,0);
                                    continue;
                                }
                                incoming.try_send(wire).map_err(|_|AgentError::code("gatewayUnavailable"))?;
                                continue;
                            },
                            Message::Close(_)=>return Err(AgentError::code("networkError")),
                            _=>return Err(protocol::invalid()),
                        }
                    },
                };
                tokio::time::timeout(Duration::from_secs(5), sink.send(frame))
                    .await
                    .map_err(|_| AgentError::code("timeout"))?
                    .map_err(network)?;
            }
        };
        let health =
            crate::execution::report_status(outgoing.clone(), &settings, &secrets, &target);
        let work = crate::execution::Session {
            directory,
            lock,
            settings: &settings,
            secrets: &secrets,
            context: &context,
            target: &target,
            keys: &keys,
            jwks: &jwks,
            clock: &clock,
        }
        .worker(outgoing, inbound);
        // Revocation/disconnect cancels in-flight execution. A possibly submitted add is already durable unknown.
        tokio::select! {result=io=>result,result=work=>result,result=health=>result}
    };
    let result = action.await;
    if let Err(error) = &result {
        trace.failed(error);
        if matches!(error.code, "rebindRequired" | "deviceLimitReached") {
            let _guard = lock.lock().await;
            let current: Identity = journal::load(directory, "identity.json")?;
            if current.credential_id == identity.credential_id
                && current.gateway == identity.gateway
            {
                crate::device::revoke(directory, &mut identity)?;
            }
        }
    }
    result
}

#[cfg(test)]
#[path = "connection_tests.rs"]
mod tests;
