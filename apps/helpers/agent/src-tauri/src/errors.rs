use std::{backtrace::Backtrace, error::Error, fmt};

// Never derive Debug for data containing settings, secrets, or HTTP payloads.
pub struct AgentError {
    pub stack: Backtrace,
    pub code: &'static str,
    source: Option<Box<dyn Error + Send + Sync>>,
    pub http_status: Option<u16>,
    pub gateway_code: Option<String>,
}
impl AgentError {
    pub fn code(code: &'static str) -> Self {
        Self {
            code,
            source: None,
            http_status: None,
            gateway_code: None,
            stack: Backtrace::force_capture(),
        }
    }
    pub fn http(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }
    pub fn gateway(code: &str) -> Self {
        let valid = !code.is_empty()
            && code.len() <= 100
            && code
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_');
        let mut error = Self::code(match code {
            "INVALID_API_KEY" | "DEVICE_KEY_MISMATCH" | "DEVICE_BINDING_REJECTED" => {
                "rebindRequired"
            }
            "SESSION_REVOKED" => "sessionRevoked",
            "DEVICE_LIMIT_REACHED" => "deviceLimitReached",
            "SERVICE_UNAVAILABLE" | "GATEWAY_UNAVAILABLE" | "SERVICE_BUSY" | "INTERNAL_ERROR" => {
                "gatewayUnavailable"
            }
            _ => "gatewayRejected",
        });
        if valid {
            error.gateway_code = Some(
                match code {
                    "INVALID_API_KEY"
                    | "SESSION_REVOKED"
                    | "DEVICE_KEY_MISMATCH"
                    | "DEVICE_BINDING_REJECTED"
                    | "DEVICE_LIMIT_REACHED"
                    | "SERVICE_UNAVAILABLE"
                    | "GATEWAY_UNAVAILABLE"
                    | "SERVICE_BUSY"
                    | "INTERNAL_ERROR"
                    | "INVALID_MESSAGE"
                    | "EXECUTION_NOT_ALLOWED"
                    | "EXECUTION_ALREADY_AUTHORIZED"
                    | "EXECUTION_MISMATCH"
                    | "DOWNLOADER_UNAVAILABLE"
                    | "DOWNLOADER_INSTANCE_MISMATCH"
                    | "STATUS_SEQUENCE_CONFLICT"
                    | "DOWNLOAD_ASSOCIATION_MISMATCH"
                    | "MESSAGE_ID_CONFLICT"
                    | "DELIVERY_EXPIRED"
                    | "COMMAND_AUTHORIZATION_MISMATCH"
                    | "IDEMPOTENCY_CONFLICT"
                    | "INVALID_DEVICE_PROOF"
                    | "CHALLENGE_EXPIRED"
                    | "AUTHENTICATION_REQUIRED"
                    | "RATE_LIMITED"
                    | "SOCKET_BACKPRESSURE" => code,
                    _ => "UNRECOGNIZED_GATEWAY_ERROR",
                }
                .into(),
            );
        }
        error
    }
    pub fn caused(code: &'static str, source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            code,
            stack: Backtrace::force_capture(),
            source: Some(Box::new(source)),
            http_status: None,
            gateway_code: None,
        }
    }
}
impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code)
    }
}
impl Error for AgentError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_ref()
            .map(|e| e.as_ref() as &(dyn Error + 'static))
    }
}
impl From<std::io::Error> for AgentError {
    fn from(error: std::io::Error) -> Self {
        Self::caused("storageError", error)
    }
}
impl From<serde_json::Error> for AgentError {
    fn from(error: serde_json::Error) -> Self {
        Self::caused("storageError", error)
    }
}
impl From<reqwest::Error> for AgentError {
    fn from(error: reqwest::Error) -> Self {
        Self::caused(
            if error.is_timeout() {
                "timeout"
            } else {
                "networkError"
            },
            error.without_url(),
        )
    }
}

impl fmt::Debug for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentError")
            .field("code", &self.code)
            .finish_non_exhaustive()
    }
}
