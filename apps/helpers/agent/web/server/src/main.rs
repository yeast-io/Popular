use popular_agent_core::{
    diagnostics::{self, Trace},
    errors::AgentError,
};
use popular_agent_web::{config::Config, server::WebServer};
use std::path::Path;

#[tokio::main]
async fn main() {
    if let Err(error) = diagnostics::initialize() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    let trace = Trace::new();
    trace.stage("web.startup.started");
    if let Err(error) = run(&trace).await {
        trace.failed(&error);
        std::process::exit(1);
    }
}
async fn run(trace: &Trace) -> Result<(), AgentError> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, directory] if flag == "--init-secrets" => {
            popular_agent_web::server::initialize(Path::new(directory))?;
            println!("{{\"initialized\":true}}");
            return Ok(());
        }
        [flag] if flag == "--health-check" => {
            let address: std::net::SocketAddr = std::env::var("AGENT_WEB_BIND")
                .unwrap_or_else(|_| "127.0.0.1:1423".into())
                .parse()
                .map_err(|e| AgentError::caused("invalidSettings", e))?;
            reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(2))
                .build()?
                .get(format!(
                    "http://{}/health/live",
                    std::net::SocketAddr::new(
                        if address.is_ipv6() {
                            std::net::Ipv6Addr::LOCALHOST.into()
                        } else {
                            std::net::Ipv4Addr::LOCALHOST.into()
                        },
                        address.port()
                    )
                ))
                .send()
                .await?
                .error_for_status()?;
            return Ok(());
        }
        [] => {}
        _ => return Err(AgentError::code("invalidSettings")),
    }
    trace.stage("web.startup.config.started");
    let config = Config::from_env()?;
    let bind = config.bind;
    let server = WebServer::new_with_trace(config, trace)?;
    trace.stage("web.startup.listener.started");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    trace.stage("web.startup.completed");
    server
        .serve(listener, async {
            #[cfg(unix)]
            {
                match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                    Ok(mut term) => {
                        tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=term.recv()=>{} }
                    }
                    Err(error) => {
                        diagnostics::failure(
                            "web.shutdown.signal",
                            "web",
                            &AgentError::caused("runtimeError", error),
                            0,
                        );
                    }
                }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
        })
        .await
}
