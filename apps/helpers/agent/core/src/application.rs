//! Host-independent operations shared by desktop and Web hosts.
use crate::{
    credentials::CredentialStore,
    diagnostics::Trace,
    errors::AgentError,
    journal::{self, Identity},
    runtime::{self, BindingState, Runtime},
    settings::{GatewayRequest, Snapshot, TestRequest},
    storage,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub struct Agent<C> {
    pub directory: PathBuf,
    pub lock: Arc<tokio::sync::Mutex<()>>,
    pub runtime: Arc<Runtime>,
    pub(crate) credentials: Arc<C>,
    pub resource_sites: crate::resource_sites::ResourceSites<C>,
    running: AtomicBool,
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl<C: CredentialStore + Send + Sync + 'static> Agent<C> {
    pub fn new(directory: PathBuf, credentials: C) -> Self {
        let runtime = Arc::new(Runtime::default());
        crate::queue::initialize(&directory, &runtime);
        let credentials = Arc::new(credentials);
        let resource_sites =
            crate::resource_sites::ResourceSites::new(directory.clone(), credentials.clone());
        Self {
            resource_sites,
            directory,
            lock: Default::default(),
            runtime,
            credentials,
            running: AtomicBool::new(false),
            shutdown: tokio::sync::watch::channel(false).0,
        }
    }

    /// One runtime per instance. The host owns this future and requests shutdown on exit.
    pub async fn run(self: Arc<Self>) -> Result<(), AgentError> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(AgentError::code("runtimeError"));
        }
        struct Running<'a>(&'a AtomicBool);
        impl Drop for Running<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _running = Running(&self.running);
        let mut shutdown = self.shutdown.subscribe();
        if *shutdown.borrow() {
            return Ok(());
        }
        tokio::select! {
            _ = runtime::run(self.clone()) => {},
            _ = crate::downloader_health::run(self.clone()) => {},
            _ = shutdown.changed() => {},
        }
        self.runtime.update(Some("disconnected"), None, None);
        Ok(())
    }

    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub async fn load_settings(&self) -> Result<Snapshot, AgentError> {
        let _guard = self.lock.lock().await;
        let directory = self.directory.clone();
        let credentials = self.credentials.clone();
        tokio::task::spawn_blocking(move || {
            let stored = storage::load(&directory)?;
            let secrets = storage::secrets(&stored, credentials.as_ref())?;
            Ok(storage::snapshot(stored, &secrets))
        })
        .await
        .map_err(|e| AgentError::caused("runtimeError", e))?
    }

    pub async fn connect_device(
        &self,
        request: GatewayRequest,
        trace: &Trace,
    ) -> Result<Snapshot, AgentError> {
        let _guard = self.lock.lock().await;
        let directory = self.directory.clone();
        let credentials = self.credentials.clone();
        let worker = trace.clone();
        let snapshot = tokio::task::spawn_blocking(move || {
            crate::gateway::request_binding(&directory, request, credentials.as_ref(), &worker)
        })
        .await
        .map_err(|e| AgentError::caused("runtimeError", e))??;
        let identity: Identity = journal::load(&self.directory, "identity.json")?;
        let binding = runtime::binding(&identity, &snapshot.settings);
        self.runtime.set_binding(
            if binding == BindingState::Unbound {
                BindingState::Binding
            } else {
                binding
            },
            identity.device_id,
        );
        self.runtime.suspended.store(false, Ordering::SeqCst);
        self.runtime.update(Some("connecting"), None, None);
        self.runtime.changed.notify_one();
        Ok(snapshot)
    }

    pub async fn test_downloader(
        &self,
        request: TestRequest,
        trace: &Trace,
    ) -> Result<Snapshot, AgentError> {
        let _guard = self.lock.lock().await;
        let snapshot = crate::downloader::test_and_save(
            &self.directory,
            request,
            self.credentials.as_ref(),
            trace,
        )
        .await?;
        self.runtime.update(None, Some("online"), None);
        self.runtime.changed.notify_one();
        self.runtime.downloader_changed.notify_one();
        Ok(snapshot)
    }

    pub async fn reset_downloader(&self, trace: &Trace) -> Result<Snapshot, AgentError> {
        let _guard = self.lock.lock().await;
        let directory = self.directory.clone();
        let credentials = self.credentials.clone();
        let worker = trace.clone();
        let snapshot = tokio::task::spawn_blocking(move || {
            crate::downloader::reset(&directory, credentials.as_ref(), &worker)
        })
        .await
        .map_err(|e| AgentError::caused("runtimeError", e))??;
        self.runtime.update(None, Some("unconfigured"), None);
        self.runtime.changed.notify_one();
        self.runtime.downloader_changed.notify_one();
        Ok(snapshot)
    }

    pub async fn save_locale(&self, locale: String) -> Result<(), AgentError> {
        let _guard = self.lock.lock().await;
        crate::preferences::locale(&self.directory, locale)
    }

    pub async fn disconnect_gateway(&self) -> Result<(), AgentError> {
        self.runtime.suspended.store(true, Ordering::SeqCst);
        self.runtime.changed.notify_one();
        let _guard = self.lock.lock().await;
        match crate::preferences::disconnect_gateway(&self.directory) {
            Ok(()) => {
                self.runtime
                    .update(Some("manuallyDisconnected"), None, None);
                self.runtime.changed.notify_one();
                Ok(())
            }
            Err(error) => {
                self.runtime.suspended.store(false, Ordering::SeqCst);
                self.runtime.changed.notify_one();
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Secrets;
    struct EmptyCredentials;
    impl CredentialStore for EmptyCredentials {
        fn read(&self, _: &str) -> Result<Secrets, AgentError> {
            panic!("no configured credentials")
        }
        fn write(&self, _: &str, _: &Secrets) -> Result<(), AgentError> {
            panic!("no credential writes")
        }
        fn delete(&self, _: &str) -> Result<(), AgentError> {
            panic!("no credential deletes")
        }
    }

    #[tokio::test]
    async fn headless_runtime_has_one_owner_and_stops_while_waiting_for_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let agent = Arc::new(Agent::new(directory.path().into(), EmptyCredentials));
        let task = tokio::spawn(agent.clone().run());
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !agent.running.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(agent.clone().run().await.is_err());
        assert!(!agent.load_settings().await.unwrap().has_api_key);
        agent.shutdown();
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!agent.running.load(Ordering::SeqCst));
        assert_eq!(agent.runtime.snapshot().service, "disconnected");
        assert!(!directory.path().join("identity.json").exists());
    }
}
