//! Durable execution and outbox. A URL exists only in a live connection's pending grant.
use crate::{
    diagnostics::{self, Trace},
    downloads::{self, Downloader},
    errors::AgentError,
    journal::{self, Journal, Record, JOURNAL},
    protocol::{self, Clock, Command, Context, DeviceKeys, DownloaderTarget, Grant, Wire},
    settings::{self, Secrets, Settings},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    time::{Duration, Instant},
};
use tokio::sync::mpsc::{Receiver, Sender};

fn evidence(task: &Value, record: &Record) -> Result<Value, AgentError> {
    let task_id = if record.target.provider == settings::Provider::Qbittorrent {
        task["hash"]
            .as_str()
            .ok_or(AgentError::code("invalidResponse"))?
            .to_lowercase()
    } else {
        task["id"]
            .as_u64()
            .filter(|n| *n <= protocol::MAX_INTEGER)
            .ok_or(AgentError::code("invalidResponse"))?
            .to_string()
    };
    if !protocol::id(&task_id) {
        return Err(protocol::invalid());
    }
    Ok(
        json!({"downloaderType":record.downloader.downloader_type,"instanceId":record.downloader.instance_id,"torrentHash":record.info_hash,"taskId":task_id,"marker":record.marker()}),
    )
}
fn unavailable(
    journal: &mut Journal,
    index: usize,
    state: &str,
    force: bool,
) -> Result<(), AgentError> {
    let record = &mut journal.records[index];
    if record.phase != "succeeded" || (!force && record.last_status["state"] == state) {
        return Ok(());
    }
    let mut snapshot = if record.last_status.is_object() {
        record.last_status.clone()
    } else {
        json!({"progress":0,"downloadedBytes":0,"totalBytes":0})
    };
    snapshot["state"] = json!(state);
    snapshot["downloadSpeed"] = json!(0);
    snapshot["uploadSpeed"] = json!(0);
    record.last_status = snapshot.clone();
    journal.event(index, "__download_status__", snapshot)
}
pub fn apply_tasks(
    journal: &mut Journal,
    index: usize,
    periodic: bool,
    force: bool,
    tasks: &[Value],
) -> Result<(), AgentError> {
    let record = &journal.records[index];
    if !record.monitoring_active() {
        return Ok(());
    }
    let task = tasks
        .iter()
        .find(|task| downloads::matches_hash(task, &record.info_hash));
    let Some(task) = task else {
        return unavailable(journal, index, "deleted", force);
    };
    if !downloads::owned(task, &record.marker()) {
        // The hash still exists, but ownership evidence was removed/replaced. Do not
        // call it deleted or adopt the manual replacement task.
        return unavailable(journal, index, "failed", force);
    }
    let found = evidence(task, record)?;
    if record.evidence.as_ref().is_some_and(|old| old != &found) {
        return unavailable(journal, index, "failed", force);
    }
    let snapshot = downloads::status(task, &record.target.provider)?;
    if matches!(record.phase.as_str(), "unknown" | "abandoned") {
        journal.records[index].evidence = Some(found);
        journal.result(index, "succeeded")?;
    }
    let record = &mut journal.records[index];
    if force
        || (periodic && snapshot["state"] == "downloading")
        || snapshot["state"] != record.last_status["state"]
    {
        record.last_status = snapshot.clone();
        journal.event(index, "__download_status__", snapshot)?;
    }
    Ok(())
}
async fn lookup(
    settings: &Settings,
    secrets: &Secrets,
    hashes: &[String],
    trace: &Trace,
) -> Result<Vec<Value>, AgentError> {
    let mut downloader =
        Downloader::connect(settings.clone(), secrets.password.clone(), trace).await?;
    downloader.probe().await?;
    downloader.tasks_many(hashes).await
}
// Independent of command execution: a slow add or verification cannot starve health reports.
pub async fn report_status(
    sender: Sender<Wire>,
    settings: &Settings,
    secrets: &Secrets,
    target: &DownloaderTarget,
) -> Result<(), AgentError> {
    let mut interval = tokio::time::interval(Duration::from_secs(20));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let trace = Trace::new();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            lookup(settings, secrets, &[], &trace),
        )
        .await
        .unwrap_or_else(|_| Err(AgentError::code("timeout")));
        if let Err(error) = &result {
            if settings.downloader_configured {
                diagnostics::failure("downloader.health.report", &trace.id, error, 0);
            }
        }
        outgoing(&sender,protocol::message("__agent_status__",json!({"downloaderType":target.downloader_type,"instanceId":target.instance_id,"configured":settings.downloader_configured,"reachable":settings.downloader_configured && result.is_ok()}),Some(trace.id))).await?;
    }
}
struct Pending {
    index: usize,
    command: Command,
    request: Wire,
}
fn redacted_digest(command: &Command) -> String {
    protocol::fingerprint(
        &json!({"protocolVersion":command.protocol_version,"command":command.command,"messageId":command.message_id,"commandId":command.command_id,"downloadId":command.download_id,
        "ownerId":command.owner_id,"deviceId":command.device_id,"authVersion":command.auth_version,"deviceVersion":command.device_version,"sessionId":command.session_id,"source":command.source,"resourceId":command.resource_id,
        "correlationId":command.correlation_id,"expiresAt":command.expires_at,"torrentHash":command.torrent_hash,"torrentUrlDigest":protocol::fingerprint(&json!(command.torrent_url)),"queueExpiresAt":command.queue_expires_at,"retryAttempt":command.retry_attempt}),
    )
}
// Stable across delivery sessions, refreshed URLs and attempts; never persists a URL.
fn intent_digest(command: &Command) -> String {
    protocol::fingerprint(
        &json!({"commandId":command.command_id,"downloadId":command.download_id,
        "source":command.source,"resourceId":command.resource_id,"torrentHash":command.torrent_hash,
        "queueExpiresAt":command.queue_expires_at}),
    )
}
fn delivery(
    journal: &Journal,
    command: &Command,
    context: &Context,
    target: &DownloaderTarget,
) -> Result<Option<usize>, AgentError> {
    let Some((index, record)) = journal
        .records
        .iter()
        .enumerate()
        .rev()
        .find(|(_, r)| r.command_id == command.command_id)
    else {
        return Ok(None);
    };
    if !record.context.same_authority(context) {
        return Err(protocol::invalid());
    }
    let attempt = command.retry_attempt.unwrap_or(0);
    let previous = record.retry_attempt.unwrap_or(0);
    if attempt < previous {
        return Err(protocol::invalid());
    }
    if attempt == previous {
        if record.delivery_digest != redacted_digest(command) {
            return Err(protocol::invalid());
        }
        return Ok(Some(index));
    }
    if record.phase != "failed"
        || record.intent_digest != intent_digest(command)
        || record.downloader != *target
        || record.queue_expires_at != command.queue_expires_at
    {
        return Err(protocol::invalid());
    }
    Ok(None)
}
async fn outgoing(sender: &Sender<Wire>, wire: Wire) -> Result<(), AgentError> {
    sender
        .send(wire)
        .await
        .map_err(|_| AgentError::code("networkError"))
}
fn validate_grant(
    grant: &Grant,
    pending: &Pending,
    record: &Record,
    context: &Context,
    target: &DownloaderTarget,
    now: u64,
) -> Result<(), AgentError> {
    if grant.protocol_version != 1
        || grant.command != "__execution_granted__"
        || grant.command_id != record.command_id
        || grant.download_id != record.download_id
        || grant.execution_id != record.execution_id
        || grant.owner_id != context.owner_id
        || grant.device_id != context.device_id
        || grant.auth_version != context.auth_version
        || grant.device_version != context.device_version
        || grant.session_id != context.session_id
        || grant.correlation_id != record.correlation_id
        || grant.torrent_hash != record.info_hash
        || grant.downloader != *target
        || grant.expires_at <= now
        || grant.expires_at > pending.command.expires_at
        || grant.expires_at > now + 30_000
    {
        return Err(protocol::invalid());
    }
    Ok(())
}
async fn execute(
    directory: &Path,
    journal: &mut Journal,
    pending: Pending,
    permission: (&Clock, u64),
    settings: &Settings,
    secrets: &Secrets,
    trace: &Trace,
) -> Result<(), AgentError> {
    let index = pending.index;
    // The authorization receipt is durable before preflight. It will never resume an add after restart.
    journal.records[index].phase = "authorized".into();
    journal::atomic(directory, JOURNAL, journal)?;
    // A saved deletion/switch may race a grant already queued on this session.
    // Check the atomic configuration under the worker's settings lock before any add.
    if directory.join("settings.json").exists() {
        let current = crate::storage::load(directory)?;
        if !current.settings.downloader_configured
            || !settings::same_downloader(&current.settings, settings)
            || crate::device::target(directory, &current.settings)?
                != journal.records[index].downloader
        {
            journal.result(index, "failed")?;
            journal::atomic(directory, JOURNAL, journal)?;
            return Err(AgentError::code("targetChanged"));
        }
    }
    let preflight = async {
        let mut downloader =
            Downloader::connect(settings.clone(), secrets.password.clone(), trace).await?;
        let tasks = downloader.tasks(&journal.records[index].info_hash).await?;
        Ok::<_, AgentError>((downloader, tasks))
    }
    .await;
    let (mut downloader, tasks) = match preflight {
        Ok(value) => value,
        Err(error) => {
            journal.result(index, "failed")?;
            journal::atomic(directory, JOURNAL, journal)?;
            return Err(error);
        }
    };
    if !tasks.is_empty() {
        journal.result(index, "duplicate")?;
        return journal::atomic(directory, JOURNAL, journal);
    }
    if permission.0.now() >= permission.1 {
        journal.result(index, "failed")?;
        return journal::atomic(directory, JOURNAL, journal);
    }
    // Persist uncertainty BEFORE HTTP. Cancellation, timeout and process death can never permit a second add.
    journal.result(index, "unknown")?;
    journal::atomic(directory, JOURNAL, journal)?;
    // File synchronization itself may span sleep or a slow disk. Give the socket
    // pump a cancellation opportunity, then check authorization again before HTTP.
    tokio::task::yield_now().await;
    if permission.0.now() >= permission.1 {
        journal.result(index, "failed")?;
        return journal::atomic(directory, JOURNAL, journal);
    }
    trace.stage("downloader.add.started");
    match downloader
        .add(
            &pending.command.torrent_url,
            &journal.records[index].marker(),
        )
        .await
    {
        Ok(false) => journal.result(index, "duplicate")?,
        Ok(true) => trace.stage("downloader.add.accepted"),
        Err(error) => diagnostics::failure("downloader.add", &trace.id, &error, 0),
    }
    journal::atomic(directory, JOURNAL, journal)?;
    if journal.records[index].phase == "unknown" {
        match downloader.tasks(&journal.records[index].info_hash).await {
            Ok(tasks) => apply_tasks(journal, index, false, false, &tasks)?,
            Err(error) => diagnostics::failure("downloader.verify", &trace.id, &error, 0),
        }
    }
    diagnostics::command("command.execution.completed", &journal.records[index]);
    journal::atomic(directory, JOURNAL, journal)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedGrant {
    grant: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recovery {
    command_id: String,
    download_id: String,
    state: String,
    expires_at: u64,
    execution_id: Option<String>,
    grant_expires_at: Option<u64>,
    result: Option<Value>,
    accepted: bool,
    added: Option<bool>,
    may_execute: bool,
}

pub struct Session<'a> {
    pub directory: &'a Path,
    pub lock: &'a tokio::sync::Mutex<()>,
    pub settings: &'a Settings,
    pub secrets: &'a Secrets,
    pub context: &'a Context,
    pub target: &'a DownloaderTarget,
    pub keys: &'a DeviceKeys,
    pub jwks: &'a Value,
    pub clock: &'a Clock,
}
impl Session<'_> {
    pub async fn worker(
        self,
        sender: Sender<Wire>,
        mut receiver: Receiver<Wire>,
    ) -> Result<(), AgentError> {
        let Self {
            directory,
            lock,
            settings,
            secrets,
            context,
            target,
            keys,
            jwks,
            clock,
        } = self;
        let mut journal: Journal = {
            let _guard = lock.lock().await;
            journal::load(directory, JOURNAL)?
        };
        let mut recover = VecDeque::new();
        let mut recovery_requests = HashMap::new();
        for record in &mut journal.records {
            // Legacy journals with a deleted snapshot and no outbox event already received its ACK.
            if record.last_status["state"] == "deleted"
                && !journal
                    .events
                    .iter()
                    .any(|event| event.wire.payload["commandId"] == record.command_id)
            {
                record.monitoring_ended_at.get_or_insert(clock.now());
            }
            if !record.context.same_authority(context) {
                continue;
            }
            if matches!(record.phase.as_str(), "prepared" | "authorized") {
                record.phase = "abandoned".into();
            }
            if record.monitoring_active()
                && matches!(record.phase.as_str(), "unknown" | "succeeded" | "abandoned")
            {
                let request = protocol::message(
                    "__execution_recovery__",
                    json!({"commandId":record.command_id,"executionId":record.execution_id}),
                    Some(record.correlation_id.clone()),
                );
                recovery_requests.insert(
                    request.message_id.clone(),
                    (
                        record.command_id.clone(),
                        record.download_id.clone(),
                        record.execution_id.clone(),
                    ),
                );
                recover.push_back(request);
            }
        }
        journal::atomic(directory, JOURNAL, &journal)?;
        let mut pending: HashMap<String, Pending> = HashMap::new();
        let mut poll = tokio::time::interval(Duration::from_secs(2));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_progress = Instant::now() - Duration::from_secs(30);
        let mut refresh = true;
        let mut last_sent: Option<(String, Instant)> = None;
        let trace = Trace::new();
        loop {
            tokio::select! {
                _=poll.tick()=>{
                    let _guard=lock.lock().await;
                    pending.retain(|_,p| p.command.expires_at>clock.now());
                    let periodic=last_progress.elapsed()>=Duration::from_secs(30);
                    if periodic {last_progress=Instant::now();}
                    if periodic && pending.is_empty() { journal.prune(clock.now()); }
                    let indices:Vec<_>=journal.records.iter().enumerate().filter(|(_,r)|r.monitoring_active() && r.context.same_authority(context) && r.downloader==*target && settings::same_downloader(&r.target,settings) && matches!(r.phase.as_str(),"unknown"|"succeeded"|"abandoned")).map(|(i,_)|i).collect();
                    let hashes:Vec<_>=indices.iter().map(|i|journal.records[*i].info_hash.clone()).collect();
                    let result=if hashes.is_empty() {Ok(Vec::new())} else {tokio::time::timeout(Duration::from_secs(5),lookup(settings,secrets,&hashes,&trace)).await.unwrap_or_else(|_|Err(AgentError::code("timeout")))};
                    match result {
                        Ok(tasks)=>for index in indices {apply_tasks(&mut journal,index,periodic,refresh,&tasks)?;},
                        Err(error)=>{for index in indices {unavailable(&mut journal,index,"unreachable",refresh)?;}diagnostics::failure("downloader.poll",&trace.id,&error,0);},
                    }
                    refresh=false;
                    for _ in 0..4 {if let Some(wire)=recover.pop_front() {outgoing(&sender,wire).await?;}}
                    journal::atomic(directory,JOURNAL,&journal)?;
                },
                received=receiver.recv()=>{
                    let Some(wire)=received else {return Ok(());};
                    let _guard=lock.lock().await;
                    match wire.command.as_str() {
                        "__add_download__"=>{
                            let command=protocol::command(&wire,keys,jwks,context,clock.now())?;
                            let digest=redacted_digest(&command);
                            if let Some(index)=delivery(&journal,&command,context,target)? {
                                let received=protocol::message("__command_received__",json!({"commandId":command.command_id}),Some(command.correlation_id.clone()));
                                outgoing(&sender,received).await?;
                                if let Some(p)=pending.values().find(|p|p.index==index) {
                                    outgoing(&sender,p.request.clone()).await?;
                                } else {
                                    let record=&journal.records[index];
                                    if matches!(record.phase.as_str(),"failed"|"unknown"|"succeeded"|"duplicate") {
                                        let mut result=json!({"outcome":record.phase});
                                        if record.phase=="succeeded" {result["evidence"]=json!(record.evidence);}
                                        journal.event(index,"__command_result__",result)?;
                                    }
                                }
                                journal::atomic(directory,JOURNAL,&journal)?;
                                continue;
                            }
                            if pending.len()>=16 {return Err(AgentError::code("gatewayUnavailable"));}
                            for old in &mut journal.records {
                                if old.download_id == command.download_id && old.command_id != command.command_id
                                    && old.context.same_authority(context) && old.phase == "succeeded" {
                                    old.monitoring_ended_at.get_or_insert(clock.now());
                                }
                            }
                            let index=journal.records.len();
                            let execution_id=uuid::Uuid::new_v4().to_string();
                            journal.records.push(Record {command_id:command.command_id.clone(),download_id:command.download_id.clone(),execution_id:execution_id.clone(),context:context.clone(),target:settings.clone(),downloader:target.clone(),info_hash:command.torrent_hash.clone(),correlation_id:command.correlation_id.clone(),delivery_digest:digest,intent_digest:intent_digest(&command),retry_attempt:command.retry_attempt,queue_expires_at:command.queue_expires_at,expires_at:command.expires_at,phase:"prepared".into(),last_status:Value::Null,evidence:None,sequence:0,monitoring_ended_at:None});
                            journal::atomic(directory,JOURNAL,&journal)?;
                            let received=protocol::message("__command_received__",json!({"commandId":command.command_id}),Some(command.correlation_id.clone()));
                            let request=protocol::message("__request_execution__",json!({"commandId":command.command_id,"executionId":execution_id}),Some(command.correlation_id.clone()));
                            let trace=Trace::with_id(command.correlation_id.clone());trace.stage("command.persisted");diagnostics::command("command.persisted",&journal.records[index]);
                            outgoing(&sender,received.clone()).await?;outgoing(&sender,request.clone()).await?;
                            pending.insert(request.message_id.clone(),Pending {index,command,request});
                        },
                        "__execution_granted__"=>{
                            let Some(p)=wire.reply_to.as_ref().and_then(|id|pending.remove(id)) else {continue;};
                            let signed:SignedGrant=protocol::parse(&wire.payload)?;
                            let grant:Grant=protocol::parse(&protocol::verify(&signed.grant,jwks)?)?;
                            let now=clock.now();
                            validate_grant(&grant,&p,&journal.records[p.index],context,target,now)?;
                            if wire.correlation_id.as_deref()!=Some(&p.command.correlation_id) {return Err(protocol::invalid());}
                            if journal.records[p.index].phase!="prepared" {continue;}
                            let trace=Trace::with_id(p.command.correlation_id.clone());trace.stage("command.execution-granted");diagnostics::command("command.execution-granted",&journal.records[p.index]);
                            if let Err(error)=execute(directory,&mut journal,p,(clock,grant.expires_at),settings,secrets,&trace).await {
                                diagnostics::failure("command.execute",&trace.id,&error,0);
                                if error.code == "storageError" { return Err(error); }
                            }
                        },
                        "__execution_denied__"=>{
                            if let Some(p)=wire.reply_to.as_ref().and_then(|id|pending.remove(id)) {journal.records[p.index].phase="abandoned".into();}
                            let error=crate::connection::remote_error(&wire)?;diagnostics::failure("command.execution-denied",wire.correlation_id.as_deref().unwrap_or(&trace.id),&error,0);
                        },
                        "__command_result_ack__"|"__download_status_ack__"=>{
                            if journal.acknowledge(&wire, clock.now()) {last_sent=None;}
                        },
                        "__execution_recovery_result__"=>{
                            let Some(expected)=wire.reply_to.as_ref().and_then(|id|recovery_requests.remove(id)) else {continue;};
                            let result:Recovery=protocol::parse(&wire.payload)?;
                            if result.may_execute || !result.accepted || result.command_id!=expected.0 || result.download_id!=expected.1 || result.execution_id.as_ref()!=Some(&expected.2)
                                || !protocol::positive(result.expires_at) || result.grant_expires_at.is_some_and(|n|!protocol::positive(n)) || result.state.is_empty()
                                || (result.added==Some(true) && result.result.as_ref().is_none_or(|r|r["outcome"]!="succeeded")) {return Err(protocol::invalid());}
                            trace.stage("command.recovery.observed");
                        },
                        "__error__"=>{let error=crate::connection::remote_error(&wire)?;diagnostics::failure("gateway.command-error",wire.correlation_id.as_deref().unwrap_or(&trace.id),&error,0);},
                        _=>return Err(protocol::invalid()),
                    }
                    journal::atomic(directory,JOURNAL,&journal)?;
                },
            }
            if let Some(event) = journal.events.iter().find(|event| {
                event.eligible(context, target)
                    && journal
                        .records
                        .iter()
                        .rev()
                        .find(|r| r.command_id == event.wire.payload["commandId"])
                        .is_none_or(|r| event.wire.payload["executionId"] == r.execution_id)
            }) {
                if last_sent.as_ref().is_none_or(|(id, when)| {
                    id != &event.wire.message_id || when.elapsed() >= Duration::from_secs(5)
                }) {
                    outgoing(&sender, event.wire.clone()).await?;
                    diagnostics::event("gateway.event.sent", event);
                    last_sent = Some((event.wire.message_id.clone(), Instant::now()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn authentication_failure_reports_configured_but_unreachable_for_both_providers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for provider in [
            settings::Provider::Qbittorrent,
            settings::Provider::Transmission,
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let config = Settings {
                downloader_configured: true,
                provider: provider.clone(),
                downloader_url: format!("http://{}", listener.local_addr().unwrap()),
                ..Settings::default()
            };
            let target = DownloaderTarget {
                downloader_type: provider,
                instance_id: "target".into(),
            };
            let secrets = Secrets::default();
            let (sender, mut receiver) = tokio::sync::mpsc::channel::<Wire>(2);
            let server = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                assert!(socket.read(&mut buffer).await.unwrap() > 0);
                socket.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                let report = receiver.recv().await.unwrap();
                assert_eq!(report.payload["configured"], true);
                assert_eq!(report.payload["reachable"], false);
                assert_eq!(report.payload["instanceId"], "target");
            };
            tokio::select! { result=report_status(sender,&config,&secrets,&target)=>panic!("unexpected exit: {}",result.unwrap_err().code), result=tokio::time::timeout(Duration::from_secs(3),server)=>{result.unwrap();} }
        }
    }
    #[tokio::test]
    async fn deletion_or_replacement_saved_before_a_queued_grant_prevents_http_add() {
        for replacement in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let command = queued();
            let settings = Settings {
                downloader_configured: true,
                ..Settings::default()
            };
            let mut record = queued_record(&command);
            record.phase = "prepared".into();
            record.target = settings.clone();
            let stored = crate::settings::StoredSettings {
                settings: if replacement {
                    settings.clone()
                } else {
                    Settings::default()
                },
                downloader_identity: Some(DownloaderTarget {
                    downloader_type: settings::Provider::Qbittorrent,
                    instance_id: "replacement".into(),
                }),
                ..Default::default()
            };
            journal::atomic(directory.path(), "settings.json", &stored).unwrap();
            let mut journal = Journal {
                records: vec![record],
                events: vec![],
            };
            let pending = Pending {
                index: 0,
                command,
                request: protocol::message("__request_execution__", json!({}), None),
            };
            let clock = Clock {
                server_ms: 1000,
                anchor: Instant::now(),
                wall_anchor: std::time::SystemTime::now(),
            };
            let result = execute(
                directory.path(),
                &mut journal,
                pending,
                (&clock, 5000),
                &settings,
                &Secrets::default(),
                &Trace::new(),
            )
            .await;
            assert_eq!(result.unwrap_err().code, "targetChanged");
            let saved: Journal = journal::load(directory.path(), JOURNAL).unwrap();
            assert_eq!(saved.records[0].phase, "failed");
            assert!(saved.records[0].evidence.is_none());
            assert_eq!(saved.events.len(), 1);
            assert_eq!(saved.events[0].wire.payload["outcome"], "failed");
        }
    }
    fn queued() -> Command {
        protocol::parse(&json!({"protocolVersion":1,"command":"__add_download__","messageId":"delivery","commandId":"command","downloadId":"download","ownerId":"owner","deviceId":"device","authVersion":1,"deviceVersion":2,"sessionId":"session","source":"mteam","resourceId":"resource","correlationId":"trace","expiresAt":5000,"queueExpiresAt":600000,"retryAttempt":1,"torrentHash":"a".repeat(40),"torrentUrl":"https://tracker.invalid/secret"})).unwrap()
    }
    fn queued_record(command: &Command) -> Record {
        protocol::parse(&json!({"commandId":command.command_id,"downloadId":command.download_id,"executionId":"first-execution",
            "context":{"ownerId":"owner","deviceId":"device","authVersion":1,"deviceVersion":2,"sessionId":"session","instanceId":"gateway"},
            "target":Settings::default(),"downloader":{"downloaderType":"qbittorrent","instanceId":"original"},"infoHash":command.torrent_hash,
            "correlationId":"trace","deliveryDigest":redacted_digest(command),"intentDigest":intent_digest(command),"retryAttempt":1,"queueExpiresAt":600000,
            "expiresAt":5000,"phase":"failed","lastStatus":null,"evidence":null,"sequence":0})).unwrap()
    }
    #[test]
    fn queued_attempts_are_durable_and_only_definite_failure_allows_a_new_execution() {
        let command = queued();
        let record = queued_record(&command);
        let context = record.context.clone();
        let target = record.downloader.clone();
        let mut journal = Journal {
            records: vec![record],
            events: vec![],
        };
        let dir = tempfile::tempdir().unwrap();
        journal::atomic(dir.path(), JOURNAL, &journal).unwrap();
        journal = journal::load(dir.path(), JOURNAL).unwrap();
        assert_eq!(
            delivery(&journal, &command, &context, &target).unwrap(),
            Some(0)
        );
        let mut next = command.clone();
        next.retry_attempt = Some(2);
        next.message_id = "new-delivery".into();
        next.torrent_url.push_str("?refreshed=1");
        assert_eq!(delivery(&journal, &next, &context, &target).unwrap(), None);
        for phase in [
            "unknown",
            "authorized",
            "prepared",
            "abandoned",
            "succeeded",
            "duplicate",
        ] {
            journal.records[0].phase = phase.into();
            assert!(
                delivery(&journal, &next, &context, &target).is_err(),
                "{phase}"
            );
        }
        journal.records[0].phase = "failed".into();
        for field in ["hash", "resource", "deadline", "download"] {
            let mut changed = next.clone();
            match field {
                "hash" => changed.torrent_hash = "b".repeat(40),
                "resource" => changed.resource_id = "other".into(),
                "deadline" => changed.queue_expires_at = Some(700000),
                _ => changed.download_id = "other".into(),
            };
            assert!(delivery(&journal, &changed, &context, &target).is_err());
        }
        let mut changed = command.clone();
        changed.torrent_url.push_str("changed");
        assert!(delivery(&journal, &changed, &context, &target).is_err());
        changed = command.clone();
        changed.retry_attempt = Some(0);
        assert!(delivery(&journal, &changed, &context, &target).is_err());
        let mut replacement = target.clone();
        replacement.instance_id = "replacement".into();
        assert!(delivery(&journal, &next, &context, &replacement).is_err());
        let mut rebound = context.clone();
        rebound.auth_version += 1;
        assert!(delivery(&journal, &next, &rebound, &target).is_err());
        let mut second = queued_record(&next);
        second.retry_attempt = Some(2);
        second.execution_id = "second-execution".into();
        journal.records.push(second);
        journal::atomic(dir.path(), JOURNAL, &journal).unwrap();
        let restored: Journal = journal::load(dir.path(), JOURNAL).unwrap();
        assert_eq!(restored.records.len(), 2);
        assert!(delivery(&restored, &command, &context, &target).is_err());
        let disk = std::fs::read_to_string(dir.path().join(JOURNAL)).unwrap();
        assert!(!disk.contains("tracker.invalid") && !disk.contains("refreshed"));
    }
    #[test]
    fn queued_fields_remain_strict_and_deadlines_never_extend_delivery() {
        let command = queued();
        assert!(command.valid_deadlines(1000));
        for (expires, queue, attempt) in [
            (61001, Some(600000), Some(1)),
            (5000, Some(4999), Some(1)),
            (5000, Some(0), Some(1)),
            (5000, Some(600000), Some(protocol::MAX_INTEGER + 1)),
        ] {
            let mut changed = command.clone();
            changed.expires_at = expires;
            changed.queue_expires_at = queue;
            changed.retry_attempt = attempt;
            assert!(!changed.valid_deadlines(1000));
        }
        let mut value = json!({"protocolVersion":1});
        assert!(protocol::parse::<Command>(&value).is_err());
        value = serde_json::json!({"protocolVersion":1,"command":"__add_download__","messageId":"delivery","commandId":"command","downloadId":"download","ownerId":"owner","deviceId":"device","authVersion":1,"deviceVersion":2,"sessionId":"session","source":"mteam","resourceId":"resource","correlationId":"trace","expiresAt":5000,"torrentHash":"a".repeat(40),"torrentUrl":"https://tracker.invalid/secret"});
        assert!(protocol::parse::<Command>(&value).is_ok());
        value["queueExpiresAt"] = Value::Null;
        assert!(protocol::parse::<Command>(&value).is_err());
        value.as_object_mut().unwrap().remove("queueExpiresAt");
        value["retryAttempt"] = json!(-1);
        assert!(protocol::parse::<Command>(&value).is_err());
        value["retryAttempt"] = json!(1.5);
        assert!(protocol::parse::<Command>(&value).is_err());
        value["retryAttempt"] = json!(1);
        value["unexpected"] = json!(true);
        assert!(protocol::parse::<Command>(&value).is_err());
    }
    #[test]
    fn manual_tasks_are_not_adopted_and_missing_markers_are_not_misreported_as_deletion() {
        let record:Record=protocol::parse(&json!({"commandId":"command","downloadId":"download","executionId":"execution",
            "context":{"ownerId":"owner","deviceId":"device","authVersion":1,"deviceVersion":1,"sessionId":"session","instanceId":"gateway"},
            "target":Settings::default(),"downloader":{"downloaderType":"qbittorrent","instanceId":"downloader"},"infoHash":"a".repeat(40),
            "correlationId":"trace","deliveryDigest":"digest","expiresAt":5000,"phase":"unknown","lastStatus":null,"evidence":null,"sequence":0})).unwrap();
        let mut journal = Journal {
            records: vec![record],
            events: vec![],
        };
        let mut task = json!({"hash":"a".repeat(40),"tags":"","state":"downloading","progress":0.5,"dlspeed":10,"upspeed":0,"total_size":1000,"downloaded":500,"uploaded":0});
        apply_tasks(&mut journal, 0, false, false, &[task.clone()]).unwrap();
        assert_eq!(journal.records[0].phase, "unknown");
        assert!(journal.events.is_empty());
        assert!(journal.records[0].evidence.is_none());
        task["tags"] = json!(journal.records[0].marker());
        apply_tasks(&mut journal, 0, false, false, &[task.clone()]).unwrap();
        assert_eq!(journal.records[0].phase, "succeeded");
        assert_eq!(journal.records[0].sequence, 1);
        task["tags"] = json!("");
        apply_tasks(&mut journal, 0, false, false, &[task]).unwrap();
        assert_eq!(journal.records[0].last_status["state"], "failed");
        apply_tasks(&mut journal, 0, false, false, &[]).unwrap();
        assert_eq!(journal.records[0].last_status["state"], "deleted");
        assert_eq!(journal.records[0].sequence, 3);
        assert!(!journal.records[0].monitoring_active());
        assert!(journal.records[0].monitoring_ended_at.is_none());
        let deletion = journal.events.last().unwrap().wire.clone();
        // A restart with a pending deletion keeps its original event and never resumes polling.
        let directory = tempfile::tempdir().unwrap();
        journal
            .events
            .retain(|event| event.wire.message_id == deletion.message_id);
        journal::atomic(directory.path(), JOURNAL, &journal).unwrap();
        journal = journal::load(directory.path(), JOURNAL).unwrap();
        let before = journal.events.len();
        apply_tasks(&mut journal, 0, true, true, &[]).unwrap();
        assert_eq!(journal.events.len(), before);
        let mut ack = protocol::message(
            "__download_status_ack__",
            json!({
                "persisted":true,"commandId":"command","executionId":"execution","sequence":2
            }),
            Some("trace".into()),
        );
        ack.reply_to = Some(deletion.message_id.clone());
        assert!(!journal.acknowledge(&ack, 1000));
        assert!(journal.records[0].monitoring_ended_at.is_none());
        ack.payload["sequence"] = json!(3);
        assert!(journal.acknowledge(&ack, 1000));
        assert_eq!(journal.records[0].monitoring_ended_at, Some(1000));
        assert!(journal.events.is_empty());
        journal::atomic(directory.path(), JOURNAL, &journal).unwrap();
        journal = journal::load(directory.path(), JOURNAL).unwrap();
        assert!(!journal.records[0].monitoring_active());
        journal.prune(1000 + 30 * 86400000 - 1);
        assert_eq!(journal.records.len(), 1);
        journal.prune(1000 + 30 * 86400000);
        assert!(journal.records.is_empty());
    }
    #[test]
    fn a_grant_is_bound_to_every_execution_identity_and_original_downloader() {
        let context = Context {
            owner_id: "owner".into(),
            device_id: "device".into(),
            auth_version: 1,
            device_version: 2,
            session_id: "session".into(),
            instance_id: "gateway".into(),
        };
        let target = DownloaderTarget {
            downloader_type: settings::Provider::Qbittorrent,
            instance_id: "original".into(),
        };
        let command:Command=protocol::parse(&json!({"protocolVersion":1,"command":"__add_download__","messageId":"delivery","commandId":"command","downloadId":"download","ownerId":"owner","deviceId":"device","authVersion":1,"deviceVersion":2,"sessionId":"session","source":"mteam","resourceId":"resource","correlationId":"trace","expiresAt":5000,"torrentHash":"a".repeat(40),"torrentUrl":"https://tracker.invalid/secret"})).unwrap();
        let record = Record {
            command_id: "command".into(),
            download_id: "download".into(),
            execution_id: "execution".into(),
            context: context.clone(),
            target: Settings::default(),
            downloader: target.clone(),
            info_hash: "a".repeat(40),
            correlation_id: "trace".into(),
            delivery_digest: "digest".into(),
            expires_at: 5000,
            retry_attempt: None,
            queue_expires_at: None,
            intent_digest: String::new(),
            phase: "prepared".into(),
            last_status: Value::Null,
            evidence: None,
            sequence: 0,
            monitoring_ended_at: None,
        };
        let pending = Pending {
            index: 0,
            command,
            request: protocol::message("__request_execution__", json!({}), None),
        };
        let valid = json!({"protocolVersion":1,"command":"__execution_granted__","commandId":"command","downloadId":"download","ownerId":"owner","deviceId":"device","authVersion":1,"deviceVersion":2,"sessionId":"session","executionId":"execution","expiresAt":2000,"correlationId":"trace","torrentHash":"a".repeat(40),"downloader":{"downloaderType":"qbittorrent","instanceId":"original"}});
        assert!(validate_grant(
            &protocol::parse(&valid).unwrap(),
            &pending,
            &record,
            &context,
            &target,
            1000
        )
        .is_ok());
        for (field, value) in [
            ("protocolVersion", json!(2)),
            ("command", json!("__other__")),
            ("commandId", json!("other")),
            ("downloadId", json!("other")),
            ("ownerId", json!("other")),
            ("deviceId", json!("other")),
            ("authVersion", json!(2)),
            ("deviceVersion", json!(3)),
            ("sessionId", json!("old")),
            ("executionId", json!("other")),
            ("expiresAt", json!(999)),
            ("expiresAt", json!(5001)),
            ("correlationId", json!("other")),
            ("torrentHash", json!("b".repeat(40))),
            (
                "downloader",
                json!({"downloaderType":"qbittorrent","instanceId":"new-instance"}),
            ),
        ] {
            let mut altered = valid.clone();
            altered[field] = value;
            assert!(
                validate_grant(
                    &protocol::parse(&altered).unwrap(),
                    &pending,
                    &record,
                    &context,
                    &target,
                    1000
                )
                .is_err(),
                "unchecked grant field: {field}"
            );
        }
    }
}
