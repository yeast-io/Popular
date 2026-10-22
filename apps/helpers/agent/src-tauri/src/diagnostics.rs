use crate::errors::AgentError;
use std::{
    error::Error,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
struct Settings {
    verbose: bool,
    level: String,
}
static LOG_DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());
pub fn directory(path: std::path::PathBuf) -> Result<(), AgentError> {
    std::fs::create_dir_all(&path)?;
    LOG_DIRECTORY
        .set(path)
        .map_err(|_| AgentError::code("runtimeError"))
}
fn emit(value: serde_json::Value) {
    let line = value.to_string();
    eprintln!("{line}");
    let Some(directory) = LOG_DIRECTORY.get() else {
        return;
    };
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let result = || -> std::io::Result<()> {
        use std::io::Write;
        let path = directory.join("diagnostics.jsonl");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 2 * 1024 * 1024) {
            let older = directory.join("diagnostics.2.jsonl");
            if older.exists() {
                std::fs::remove_file(&older)?;
            }
            let previous = directory.join("diagnostics.1.jsonl");
            if previous.exists() {
                std::fs::rename(previous, older)?;
            }
            std::fs::rename(&path, directory.join("diagnostics.1.jsonl"))?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        writeln!(options.open(path)?, "{line}")
    };
    if result().is_err() {
        eprintln!("{{\"level\":\"error\",\"stage\":\"diagnostics.write\",\"errorCode\":\"storageError\"}}");
    }
}
static SETTINGS: OnceLock<Settings> = OnceLock::new();
pub fn initialize() -> Result<(), &'static str> {
    let _ = dotenvy::dotenv();
    let verbose = match std::env::var("VERBOSE").as_deref() {
        Ok("true") => true,
        Ok("false") | Err(std::env::VarError::NotPresent) => false,
        _ => return Err("VERBOSE must be true or false"),
    };
    let level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".into());
    if !matches!(
        level.as_str(),
        "trace" | "debug" | "info" | "warn" | "error" | "off"
    ) {
        return Err("Invalid LOG_LEVEL");
    }
    SETTINGS
        .set(Settings { verbose, level })
        .map_err(|_| "Diagnostics already initialized")
}
#[cfg(test)]
pub fn quiet_tests() {
    let _ = SETTINGS.set(Settings {
        verbose: false,
        level: "off".into(),
    });
}
#[derive(Clone)]
pub struct Trace {
    pub id: String,
    started: Instant,
    current_stage: Arc<Mutex<String>>,
}
impl Trace {
    pub fn new() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            started: Instant::now(),
            current_stage: Arc::new(Mutex::new("operation.started".into())),
        }
    }
    pub fn with_id(id: String) -> Self {
        Self { id, ..Self::new() }
    }
    pub fn stage(&self, stage: &str) {
        *self.current_stage.lock().unwrap_or_else(|e| e.into_inner()) = stage.into();
        if SETTINGS
            .get()
            .is_some_and(|s| s.verbose && matches!(s.level.as_str(), "trace" | "debug" | "info"))
        {
            emit(
                serde_json::json!({"level":"info", "stage":stage,"correlationId":self.id,"durationMs":self.started.elapsed().as_millis(), "outcome":stage.rsplit('.').next(),"retryAttempt":0}),
            );
        }
    }
    pub fn failed(&self, error: &AgentError) {
        failure(
            &self.current_stage.lock().unwrap_or_else(|e| e.into_inner()),
            &self.id,
            error,
            self.started.elapsed().as_millis(),
        );
    }
    pub fn finish<T>(&self, operation: &str, result: Result<T, AgentError>) -> Result<T, String> {
        match result {
            Ok(value) => {
                self.stage(&format!("{operation}.completed"));
                Ok(value)
            }
            Err(error) => {
                failure(
                    &self.current_stage.lock().unwrap_or_else(|e| e.into_inner()),
                    &self.id,
                    &error,
                    self.started.elapsed().as_millis(),
                );
                Err(error.code.into())
            }
        }
    }
}
// Reuse the probe's structured diagnostics convention. Retain original errors in
// AgentError and walk their source chain, but never format arbitrary native or
// remote errors: they may embed secrets or untrusted response bodies.
fn category(error: &(dyn Error + 'static)) -> String {
    if let Some(e) = error.downcast_ref::<AgentError>() {
        return e.code.into();
    }
    if let Some(e) = error.downcast_ref::<std::io::Error>() {
        return format!("io:{:?}:os:{:?}", e.kind(), e.raw_os_error());
    }
    if let Some(e) = error.downcast_ref::<reqwest::Error>() {
        return format!(
            "http:timeout={}:connect={}:decode={}",
            e.is_timeout(),
            e.is_connect(),
            e.is_decode()
        );
    }
    if let Some(e) = error.downcast_ref::<keyring::Error>() {
        return match e {
            keyring::Error::NoEntry => "credential:missing",
            keyring::Error::NoStorageAccess(_) => "credential:access-denied",
            keyring::Error::BadEncoding(_) => "credential:encoding",
            keyring::Error::TooLong(_, _) => "credential:platform-length-limit",
            _ => "credential:platform-error",
        }
        .into();
    }
    if let Some(e) = error.downcast_ref::<serde_json::Error>() {
        return format!(
            "json:{:?}:line={}:column={}",
            e.classify(),
            e.line(),
            e.column()
        );
    }
    "redacted-source".into()
}
pub fn failure(stage: &str, id: &str, error: &AgentError, duration: u128) {
    if SETTINGS.get().is_some_and(|s| s.level == "off") {
        return;
    }
    let mut causes = Vec::new();
    let mut source = error.source();
    while let Some(error) = source {
        causes.push(category(error));
        source = error.source();
    }
    emit(
        serde_json::json!({"level":"error","stage":stage,"correlationId":id,"durationMs":duration,"outcome":"failed","errorCode":error.code,"httpStatus":error.http_status,"gatewayCode":error.gateway_code,"causes":causes,"stack":error.stack.to_string()}),
    );
}

pub fn event(stage: &str, event: &crate::journal::Event) {
    if SETTINGS
        .get()
        .is_some_and(|s| s.verbose && matches!(s.level.as_str(), "trace" | "debug" | "info"))
    {
        emit(
            serde_json::json!({"level":"info","stage":stage,"correlationId":event.wire.correlation_id,"commandId":event.wire.payload["commandId"],"executionId":event.wire.payload["executionId"],"eventId":event.wire.message_id,"sequence":event.wire.payload.get("sequence"),"outcome":stage.rsplit('.').next()}),
        );
    }
}

pub fn retry(attempt: u64, delay_ms: u64) {
    if SETTINGS
        .get()
        .is_some_and(|s| s.verbose && matches!(s.level.as_str(), "trace" | "debug" | "info"))
    {
        emit(
            serde_json::json!({"level":"info","stage":"gateway.retry.scheduled","correlationId":"gateway","retryAttempt":attempt,"delayMs":delay_ms,"outcome":"scheduled"}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_and_native_sources_cannot_inject_secrets_into_diagnostics() {
        let error = AgentError::caused(
            "networkError",
            std::io::Error::other(
                "API_KEY password private-key passkey https://tracker.example/?SECRET",
            ),
        );
        assert_eq!(category(&error), "networkError");
        let source = category(error.source().unwrap());
        assert!(!source.contains("SECRET"));
        assert!(!source.contains("password"));
        assert!(!source.contains("tracker"));
        assert_eq!(
            category(&keyring::Error::BadEncoding(b"SECRET".to_vec())),
            "credential:encoding"
        );
    }
}
