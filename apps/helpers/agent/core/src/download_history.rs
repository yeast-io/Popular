//! Public, credential-free projection of this installation's durable execution journal.
use crate::{
    errors::AgentError,
    journal::{self, Journal},
    settings::Provider,
};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub download_id: String,
    pub execution_id: String,
    pub provider: Provider,
    pub phase: String,
    pub state: Option<String>,
    pub progress: Option<f64>,
}

pub fn list(directory: &Path) -> Result<Vec<Item>, AgentError> {
    let journal: Journal = journal::load(directory, journal::JOURNAL)?;
    Ok(journal
        .records
        .into_iter()
        .rev()
        .map(|record| Item {
            download_id: record.download_id,
            execution_id: record.execution_id,
            provider: record.target.provider,
            phase: record.phase,
            state: record.last_status["state"].as_str().map(str::to_owned),
            progress: record.last_status["progress"]
                .as_f64()
                .filter(|v| v.is_finite() && (0.0..=1.0).contains(v)),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_survives_reload_and_only_exposes_public_fields_in_reverse_order() {
        let directory = tempfile::tempdir().unwrap();
        assert!(list(directory.path()).unwrap().is_empty());
        let mut record = json!({
            "commandId":"command", "downloadId":"download", "executionId":"first",
            "context":{"ownerId":"owner-private","deviceId":"device","authVersion":1,"deviceVersion":1,"sessionId":"session-private","instanceId":"instance"},
            "target":crate::settings::Settings { username:"private-user".into(), ..Default::default() },
            "downloader":{"downloaderType":"qbittorrent","instanceId":"instance"},
            "infoHash":"private-hash","correlationId":"trace","deliveryDigest":"digest",
            "expiresAt":5000,"phase":"succeeded","lastStatus":{"state":"completed","progress":1.0,"extra":"private-extra"},
            "evidence":{"private":"evidence"},"sequence":1
        });
        let first = record.clone();
        record["executionId"] = json!("second");
        record["lastStatus"] = json!({"state":"downloading","progress":2.0});
        journal::atomic(
            directory.path(),
            journal::JOURNAL,
            &json!({"records":[first,record],"events":[]}),
        )
        .unwrap();
        let output = serde_json::to_value(list(directory.path()).unwrap()).unwrap();
        assert_eq!(output[0]["executionId"], "second");
        assert!(output[0]["progress"].is_null());
        assert_eq!(output[1]["state"], "completed");
        assert_eq!(output[1]["progress"], 1.0);
        assert_eq!(output[1].as_object().unwrap().len(), 6);
        assert!(!output.to_string().contains("private"));
        assert_eq!(
            serde_json::to_value(list(directory.path()).unwrap()).unwrap(),
            output
        );
    }

    #[test]
    fn corrupt_journal_is_an_error_not_an_empty_history() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(journal::JOURNAL), b"broken").unwrap();
        assert!(list(directory.path()).is_err());
    }
}
