//! Signed, session-bound business RPC. Never exposes raw HTTP or credentials.
use crate::{
    credentials::CredentialStore,
    diagnostics::{self, Trace},
    errors::AgentError,
    protocol::{self, Clock, Context, Wire},
    resource_sites::{resources::ResourceRequest, tickets::ResourceTickets, ResourceSites},
};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::{Receiver, Sender};
pub(crate) trait ResourceOperations: Send + Sync {
    fn request<'a>(
        &'a self,
        input: ResourceRequest,
        context: &'a Context,
        tickets: &'a ResourceTickets,
        trace: &'a Trace,
    ) -> BoxFuture<'a, Result<Value, AgentError>>;
}
impl<C: CredentialStore + Send + Sync + 'static> ResourceOperations for ResourceSites<C> {
    fn request<'a>(
        &'a self,
        input: ResourceRequest,
        context: &'a Context,
        tickets: &'a ResourceTickets,
        trace: &'a Trace,
    ) -> BoxFuture<'a, Result<Value, AgentError>> {
        Box::pin(self.operate(input, context, tickets, trace))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    command: String,
    message_id: String,
    correlation_id: String,
    expires_at: u64,
    request: ResourceRequest,
    owner_id: String,
    device_id: String,
    auth_version: u64,
    device_version: u64,
    session_id: String,
    instance_id: String,
}
async fn execute(
    resources: Option<&dyn ResourceOperations>,
    wire: Wire,
    context: &Context,
    jwks: &Value,
    clock: &Clock,
    tickets: &ResourceTickets,
    sender: Sender<Wire>,
) -> Result<(), AgentError> {
    let trace = Trace::with_id(
        wire.correlation_id
            .clone()
            .unwrap_or_else(|| wire.message_id.clone()),
    );
    trace.stage("agent-resource.request.started");
    let result = async {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Token {
            request: String,
        }
        let token: Token = protocol::parse(&wire.payload)?;
        let value = protocol::verify(&token.request, jwks)?;
        context.check(&value)?;
        let request: Request = protocol::parse(&value)?;
        if request.protocol_version != 1
            || request.command != "__resource_request__"
            || request.message_id != wire.message_id
            || request.correlation_id != trace.id
            || request.expires_at <= clock.now()
            || request.expires_at > clock.now() + 30_000
            || request.owner_id != context.owner_id
            || request.device_id != context.device_id
            || request.auth_version != context.auth_version
            || request.device_version != context.device_version
            || request.session_id != context.session_id
            || request.instance_id != context.instance_id
        {
            return Err(protocol::invalid());
        }
        let Some(resources) = resources else {
            return Err(AgentError::code("siteUnsupported"));
        };
        tokio::time::timeout(
            std::time::Duration::from_millis(request.expires_at.saturating_sub(clock.now())),
            resources.request(request.request, context, tickets, &trace),
        )
        .await
        .map_err(|_| AgentError::code("siteTimeout"))?
    }
    .await;
    let payload = match result {
        Ok(result) => {
            trace.stage("agent-resource.request.completed");
            json!({"ok":true,"result":result})
        }
        Err(error) => {
            trace.failed(&error);
            json!({"ok":false,"code":if error.code.starts_with("site"){error.code}else{"siteRemoteError"}})
        }
    };
    let mut response = protocol::message("__resource_response__", payload, Some(trace.id));
    response.reply_to = Some(wire.message_id);
    if serde_json::to_vec(&response)?.len() > 60_000 {
        response.payload = json!({"ok":false,"code":"siteInvalidResponse"});
    }
    sender
        .send(response)
        .await
        .map_err(|e| AgentError::caused("gatewayUnavailable", e))
}
pub(crate) async fn worker(
    resources: Option<&dyn ResourceOperations>,
    context: &Context,
    jwks: &Value,
    clock: &Clock,
    tickets: &ResourceTickets,
    sender: Sender<Wire>,
    mut receiver: Receiver<Wire>,
) -> Result<(), AgentError> {
    // Futures borrow this session; dropping the worker cancels all network work and tickets.
    let mut work = futures_util::stream::FuturesUnordered::new();
    use futures_util::StreamExt;
    loop {
        tokio::select! {
         Some(result)=work.next(),if !work.is_empty()=>{if let Err(error)=result{diagnostics::failure("agent-resource.response",&context.session_id,&error,0);}},
         request=receiver.recv(),if work.len()<4=>{let Some(wire)=request else{return Ok(());};work.push(execute(resources,wire,context,jwks,clock,tickets,sender.clone()));}
        }
    }
}
