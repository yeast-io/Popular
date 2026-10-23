use crate::{errors::AgentError, settings::Settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, path::Path};

pub fn atomic<T: Serialize>(directory: &Path, name: &str, value: &T) -> Result<(), AgentError> {
    std::fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.as_file().sync_all()?;
    file.persist(directory.join(name))
        .map_err(|e| AgentError::from(e.error))?;
    #[cfg(unix)]
    std::fs::File::open(directory)?.sync_all()?;
    Ok(())
}
pub fn load<T: serde::de::DeserializeOwned + Default>(
    directory: &Path,
    name: &str,
) -> Result<T, AgentError> {
    match std::fs::read(directory.join(name)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub installation_id: String,
    pub credential_id: String,
    pub gateway: String,
    pub device_id: Option<String>,
    pub revoked: bool,
    #[serde(default)]
    pub binding_requested: bool,
    #[serde(default)]
    pub protocol_version: u8,
}

pub const JOURNAL: &str = "gateway-journal.json";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub command_id: String,
    pub download_id: String,
    pub execution_id: String,
    pub context: crate::protocol::Context,
    pub target: Settings,
    pub downloader: crate::protocol::DownloaderTarget,
    pub info_hash: String,
    pub correlation_id: String,
    pub delivery_digest: String,
    pub expires_at: u64,
    #[serde(default)]
    pub retry_attempt: Option<u64>,
    #[serde(default)]
    pub queue_expires_at: Option<u64>,
    #[serde(default)]
    pub intent_digest: String,
    pub phase: String,
    pub last_status: Value,
    pub evidence: Option<Value>,
    pub sequence: u64,
    #[serde(default)]
    pub monitoring_ended_at: Option<u64>,
}
impl Record {
    pub fn monitoring_active(&self) -> bool {
        self.monitoring_ended_at.is_none() && self.last_status["state"] != "deleted"
    }
    pub fn marker(&self) -> String {
        format!("popular-{}", self.execution_id)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub wire: crate::protocol::Wire,
    pub context: crate::protocol::Context,
    pub downloader: crate::protocol::DownloaderTarget,
}
impl Event {
    pub fn eligible(
        &self,
        context: &crate::protocol::Context,
        target: &crate::protocol::DownloaderTarget,
    ) -> bool {
        self.context.same_authority(context)
            && (self.wire.command != "__download_status__" || self.downloader == *target)
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Journal {
    pub records: Vec<Record>,
    pub events: Vec<Event>,
}
impl Journal {
    pub fn prune(&mut self, now: u64) {
        const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
        self.records.retain(|record| {
            record
                .monitoring_ended_at
                .is_none_or(|ended| now < ended.saturating_add(RETENTION_MS))
                || self
                    .events
                    .iter()
                    .any(|event| event.wire.payload["commandId"] == record.command_id)
        });
    }
    pub fn event(
        &mut self,
        index: usize,
        command: &str,
        mut data: Value,
    ) -> Result<(), AgentError> {
        let record = &mut self.records[index];
        data["commandId"] = json!(record.command_id);
        data["executionId"] = json!(record.execution_id);
        if command == "__download_status__" {
            if record.phase != "succeeded" || record.evidence.is_none() {
                return Err(AgentError::code("storageError"));
            }
            record.sequence = record
                .sequence
                .checked_add(1)
                .filter(|n| *n <= crate::protocol::MAX_INTEGER)
                .ok_or(AgentError::code("storageError"))?;
            data["sequence"] = json!(record.sequence);
            data["evidence"] = json!(record.evidence);
        }
        self.events.push(Event {
            wire: crate::protocol::message(command, data, Some(record.correlation_id.clone())),
            context: record.context.clone(),
            downloader: record.downloader.clone(),
        });
        Ok(())
    }
    pub fn result(&mut self, index: usize, phase: &str) -> Result<(), AgentError> {
        if !matches!(phase, "succeeded" | "duplicate" | "failed" | "unknown") {
            return Err(AgentError::code("storageError"));
        }
        let record = &mut self.records[index];
        if record.phase == phase {
            return Ok(());
        }
        if matches!(record.phase.as_str(), "succeeded" | "duplicate" | "failed") {
            return Err(AgentError::code("storageError"));
        }
        let mut data = json!({"outcome":phase});
        if phase == "succeeded" {
            data["evidence"] = record
                .evidence
                .clone()
                .ok_or(AgentError::code("storageError"))?;
        }
        record.phase = phase.into();
        self.event(index, "__command_result__", data)
    }
    pub fn acknowledge(&mut self, ack: &crate::protocol::Wire, now: u64) -> bool {
        let Some(index) = self
            .events
            .iter()
            .position(|event| Some(event.wire.message_id.as_str()) == ack.reply_to.as_deref())
        else {
            return false;
        };
        let event = &self.events[index];
        let data = &event.wire.payload;
        let expected = if event.wire.command == "__command_result__" {
            json!({"persisted":true,"commandId":data["commandId"],"executionId":data["executionId"],"outcome":data["outcome"]})
        } else {
            json!({"persisted":true,"commandId":data["commandId"],"executionId":data["executionId"],"sequence":data["sequence"]})
        };
        let expected_command = format!("{}_ack__", event.wire.command.trim_end_matches("__"));
        if ack.command != expected_command
            || ack.payload != expected
            || ack.correlation_id != event.wire.correlation_id
        {
            return false;
        }
        if event.wire.command == "__download_status__" && data["state"] == "deleted" {
            if let Some(record) = self.records.iter_mut().find(|record| {
                record.command_id == data["commandId"] && record.execution_id == data["executionId"]
            }) {
                record.monitoring_ended_at = Some(now);
            }
        }
        self.events.remove(index);
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn event_retries_keep_original_identity_and_ack_checks_the_entire_receipt() {
        let context = crate::protocol::Context {
            owner_id: "owner".into(),
            device_id: "device".into(),
            auth_version: 1,
            device_version: 1,
            session_id: "session".into(),
            instance_id: "gateway".into(),
        };
        let downloader = crate::protocol::DownloaderTarget {
            downloader_type: crate::settings::Provider::Qbittorrent,
            instance_id: "downloader".into(),
        };
        let event = Event {
            wire: crate::protocol::message(
                "__command_result__",
                json!({"commandId":"command","executionId":"execution","outcome":"unknown"}),
                Some("trace".into()),
            ),
            context,
            downloader,
        };
        let mut journal = Journal {
            records: vec![],
            events: vec![event.clone()],
        };
        let directory = tempfile::tempdir().unwrap();
        atomic(directory.path(), JOURNAL, &journal).unwrap();
        let restored: Journal = load(directory.path(), JOURNAL).unwrap();
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::to_value(&restored.events[0]).unwrap()
        );
        let mut ack = crate::protocol::message(
            "__command_result_ack__",
            json!({"persisted":true,"commandId":"command","executionId":"other","outcome":"unknown"}),
            Some("trace".into()),
        );
        ack.reply_to = Some(event.wire.message_id);
        assert!(!journal.acknowledge(&ack, 1000));
        ack.payload["executionId"] = json!("execution");
        assert!(journal.acknowledge(&ack, 1000));
        assert!(journal.events.is_empty());
    }
}
