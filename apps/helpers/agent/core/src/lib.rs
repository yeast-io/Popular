//! Shared Agent business runtime. No desktop or HTTP framework dependencies.
pub mod application;
mod connection;
pub mod credentials;
mod device;
pub mod diagnostics;
pub mod download_history;
mod downloader;
mod downloader_health;
pub mod downloader_profiles;
mod downloads;
pub mod errors;
mod execution;
mod gateway;
mod journal;
pub mod preferences;
mod protocol;
pub mod queue;
pub mod runtime;
pub mod settings;
pub mod storage;
#[path = "web-diagnostics.rs"]
pub mod web_diagnostics;

#[path = "resource-sites/mod.rs"]
pub mod resource_sites;

mod resource_requests;
