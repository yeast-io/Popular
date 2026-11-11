//! Additional transport observability, explicitly enabled by the Web/Docker host.
//! Desktop never opts in. Only allowlisted metadata is emitted, never payloads.
use crate::{
    diagnostics::{self, Trace},
    errors::AgentError,
    protocol,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio_tungstenite::tungstenite::Message;

static WEB_HOST: AtomicBool = AtomicBool::new(false);

pub fn enable() {
    WEB_HOST.store(true, Ordering::Relaxed);
}
fn enabled() -> bool {
    WEB_HOST.load(Ordering::Relaxed) && diagnostics::verbose_enabled()
}
fn log(trace: &Trace, stage: &str, mut details: Value) {
    if !enabled() {
        return;
    }
    details["timestampMs"] = json!(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());
    details["level"] = json!("info");
    details["host"] = json!("web");
    details["stage"] = json!(stage);
    details["correlationId"] = json!(trace.id);
    diagnostics::emit(details);
}
pub fn configuration(
    trace: &Trace,
    bind: SocketAddr,
    origin: &str,
    data: &Path,
    master_key: &Path,
    environment_login: bool,
) {
    log(
        trace,
        "web.configuration.loaded",
        json!({"bindAddress":bind.ip().to_string(),"port":bind.port(),"origin":origin,"dataDirectory":data,"masterKeyFile":master_key,"authentication":if environment_login {"environment"} else {"password-file"},"outcome":"completed"}),
    );
}
pub fn listening(trace: &Trace, address: SocketAddr, origin: &str, version: &str) {
    log(
        trace,
        "web.server.listening",
        json!({"bindAddress":address.ip().to_string(),"port":address.port(),"origin":origin,"version":version,"outcome":"completed"}),
    );
}
pub fn shutdown(trace: &Trace, signal: &str) {
    log(
        trace,
        "web.shutdown.requested",
        json!({"signal":signal,"outcome":"requested"}),
    );
}
pub fn stopped(trace: &Trace, error: Option<&AgentError>) {
    log(
        trace,
        "web.server.stopped",
        json!({"outcome":if error.is_some(){"failed"}else{"completed"},"errorCode":error.map(|e|e.code)}),
    );
}
fn route(path: &str) -> &'static str {
    match path {
        "/" => "/",
        "/index.html" => "/index.html",
        "/health/live" => "/health/live",
        "/health/ready" => "/health/ready",
        "/api/session" => "/api/session",
        "/api/resource-sites" => "/api/resource-sites",
        "/api/resource-sites/configure" => "/api/resource-sites/configure",
        "/api/resource-sites/verify" => "/api/resource-sites/verify",
        "/api/resource-sites/enabled" => "/api/resource-sites/enabled",
        "/api/resource-sites/remove" => "/api/resource-sites/remove",
        "/api/settings" => "/api/settings",
        "/api/runtime" => "/api/runtime",
        "/api/gateway/connect" => "/api/gateway/connect",
        "/api/gateway/disconnect" => "/api/gateway/disconnect",
        "/api/downloader/test" => "/api/downloader/test",
        "/api/downloader/reset" => "/api/downloader/reset",
        "/api/locale" => "/api/locale",
        "/api/queue" => "/api/queue",
        "/api/queue/page" => "/api/queue/page",
        "/api/events" => "/api/events",
        path if path.starts_with("/assets/") => "/assets/*",
        _ => "<unmatched>",
    }
}
fn http_metadata(method: &str, path: &str, peer: SocketAddr) -> Value {
    let method = match method {
        "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "CONNECT" | "TRACE" => {
            method
        }
        _ => "OTHER",
    };
    json!({"method":method,"route":route(path),"peerAddress":peer.ip().to_string(),"peerPort":peer.port()})
}
pub fn http_started(trace: &Trace, method: &str, path: &str, peer: SocketAddr) {
    let mut details = http_metadata(method, path, peer);
    details["outcome"] = json!("started");
    log(trace, "http.access.started", details);
}
pub fn http_responded(
    trace: &Trace,
    method: &str,
    path: &str,
    peer: SocketAddr,
    status: u16,
    elapsed: u128,
) {
    let mut details = http_metadata(method, path, peer);
    details["httpStatus"] = json!(status);
    details["durationMs"] = json!(elapsed);
    details["outcome"] = json!(if status >= 400 { "failed" } else { "completed" });
    log(trace, "http.access.responded", details);
}

/// A cancelled request/session/stream still produces a final lifecycle record.
pub struct Span {
    trace: Trace,
    prefix: &'static str,
    details: Value,
    started: Instant,
    finished: bool,
}
impl Span {
    fn new(trace: &Trace, prefix: &'static str, mut details: Value) -> Option<Self> {
        if !enabled() {
            return None;
        }
        details["outcome"] = json!("started");
        log(trace, &format!("{prefix}.started"), details.clone());
        Some(Self {
            trace: trace.clone(),
            prefix,
            details,
            started: Instant::now(),
            finished: false,
        })
    }
    pub fn finish(mut self, error: Option<&AgentError>, status: Option<u16>) {
        self.finished = true;
        self.details["durationMs"] = json!(self.started.elapsed().as_millis());
        self.details["outcome"] = json!(if error.is_some() {
            "failed"
        } else {
            "completed"
        });
        self.details["errorCode"] = json!(error.map(|e| e.code));
        self.details["gatewayCode"] = json!(error.and_then(|e| e.gateway_code.as_deref()));
        self.details["httpStatus"] = json!(status.or_else(|| error.and_then(|e| e.http_status)));
        log(
            &self.trace,
            &format!(
                "{}.{}",
                self.prefix,
                if error.is_some() {
                    "failed"
                } else {
                    "completed"
                }
            ),
            self.details.clone(),
        );
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if !self.finished {
            self.details["durationMs"] = json!(self.started.elapsed().as_millis());
            self.details["outcome"] = json!("cancelled");
            log(
                &self.trace,
                &format!("{}.closed", self.prefix),
                self.details.clone(),
            );
        }
    }
}
pub fn stream(trace: &Trace) -> Option<Span> {
    Span::new(trace, "http.events", json!({"route":"/api/events"}))
}
pub fn gateway_session(trace: &Trace) -> Option<Span> {
    Span::new(trace, "gateway.session", json!({}))
}
pub fn gateway_http(trace: &Trace, url: &url::Url) -> Option<Span> {
    Span::new(
        trace,
        "gateway.http",
        json!({"method":"GET","route":"/client/v1/signing-keys","direction":"outbound","scheme":url.scheme(),"hostname":url.host_str(),"port":url.port_or_known_default()}),
    )
}
pub fn gateway_connect(trace: &Trace, url: &url::Url) -> Option<Span> {
    Span::new(
        trace,
        "gateway.websocket.connect",
        json!({"scheme":url.scheme(),"hostname":url.host_str(),"port":url.port_or_known_default(),"route":"/client/v1/socket"}),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    command: String,
    message_id: String,
    correlation_id: Option<String>,
    reply_to: Option<String>,
}
fn command(value: &str) -> &'static str {
    match value {
        "__authenticate__" => "__authenticate__",
        "__auth_challenge__" => "__auth_challenge__",
        "__auth_proof__" => "__auth_proof__",
        "__auth_result__" => "__auth_result__",
        "__session_revoked__" => "__session_revoked__",
        "__agent_status__" => "__agent_status__",
        "__queue_request__" => "__queue_request__",
        "__queue_snapshot__" => "__queue_snapshot__",
        "__resource_request__" => "__resource_request__",
        "__resource_response__" => "__resource_response__",
        "__add_download__" => "__add_download__",
        "__command_received__" => "__command_received__",
        "__command_result__" => "__command_result__",
        "__command_result_ack__" => "__command_result_ack__",
        "__download_status__" => "__download_status__",
        "__download_status_ack__" => "__download_status_ack__",
        "__execution_denied__" => "__execution_denied__",
        "__execution_granted__" => "__execution_granted__",
        "__execution_recovery__" => "__execution_recovery__",
        "__execution_recovery_result__" => "__execution_recovery_result__",
        "__request_execution__" => "__request_execution__",
        "__error__" => "__error__",
        _ => "<unknown>",
    }
}
fn frame_metadata(frame: &Message) -> Value {
    let mut details = json!({"bytes":frame.len()});
    details["frameType"] = json!(match frame {
        Message::Text(_) => "text",
        Message::Binary(_) => "binary",
        Message::Ping(_) => "ping",
        Message::Pong(_) => "pong",
        Message::Close(_) => "close",
        Message::Frame(_) => "frame",
    });
    if let Message::Text(text) = frame {
        if let Ok(header) = serde_json::from_str::<Header>(text) {
            details["command"] = json!(command(&header.command));
            details["messageId"] = json!(Some(header.message_id).filter(|id| protocol::id(id)));
            details["messageCorrelationId"] =
                json!(header.correlation_id.filter(|id| protocol::id(id)));
            details["replyTo"] = json!(header.reply_to.filter(|id| protocol::id(id)));
        } else {
            details["command"] = json!("<invalid>");
        }
    }
    if let Message::Close(Some(close)) = frame {
        details["closeCode"] = json!(u16::from(close.code));
    }
    details
}
pub fn sending(trace: &Trace, frame: &Message) -> Option<Span> {
    if !enabled() {
        return None;
    }
    let mut details = frame_metadata(frame);
    details["direction"] = json!("outbound");
    Span::new(trace, "gateway.websocket.send", details)
}
pub fn received(trace: &Trace, frame: &Message) {
    if !enabled() {
        return;
    }
    let mut details = frame_metadata(frame);
    details["direction"] = json!("inbound");
    details["outcome"] = json!("received");
    log(trace, "gateway.websocket.received", details);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payloads_unknown_commands_paths_and_control_frames_are_redacted() {
        let frame=Message::Text(json!({"command":"__auth_proof__","messageId":"message-1","correlationId":"correlation-1","replyTo":"reply-1","payload":{"password":"SECRET","proof":"SECRET","token":"SECRET","conversation":"SECRET"}}).to_string().into());
        let details = frame_metadata(&frame);
        assert_eq!(details["command"], "__auth_proof__");
        assert_eq!(details["messageId"], "message-1");
        assert!(!details.to_string().contains("SECRET"));
        assert!(!frame_metadata(&Message::Ping(b"SECRET".to_vec().into()))
            .to_string()
            .contains("SECRET"));
        assert_eq!(command("__private_secret__"), "<unknown>");
        assert_eq!(route("/api/SECRET"), "<unmatched>");
        assert_eq!(route("/assets/SECRET"), "/assets/*");
    }
    #[test]
    fn shared_core_does_not_enable_web_logs_by_default() {
        assert!(!WEB_HOST.load(Ordering::Relaxed));
        assert!(sending(&Trace::new(), &Message::Ping(Vec::new().into())).is_none());
    }
}
