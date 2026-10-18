# Project Agent Instructions

## Implementation authorization

- Do not create, edit, delete, or generate project code unless the user explicitly authorizes implementation.
- Treat requests as discussion, analysis, design, review, or requirements clarification unless the user clearly says `实现 ...`, `implement ...`, or gives an equivalently explicit instruction to make the changes.
- A description of desired product behavior is not implementation authorization. For example, “点击电影后展示详情” means discuss and clarify the requirement; it does not mean modify the repository.
- Requests to inspect, explain, diagnose, review, or propose a solution authorize read-only investigation only.
- During requirements discussion, identify ambiguities, constraints, tradeoffs, data ownership, acceptance criteria, and edge cases before proposing implementation.
- After the requirements are sufficiently clear, summarize the agreed scope and ask the user whether to begin implementation.
- Do not interpret urgency, detailed requirements, or continued discussion as permission to implement.
- If implementation authorization is ambiguous, ask one concise question and wait. Do not modify files while waiting.

## Explicitly authorized non-code changes

- The agent may create or edit documentation when the user explicitly requests that specific documentation change.
- The agent may revert only its own unintended changes when the user asks it to stop or revert them.

## Working principles

- Prioritize truth, accuracy, and rigorous reasoning over agreement or reassurance.
- Challenge unsupported or flawed assumptions directly and constructively.
- Clearly distinguish facts, reasonable inferences, uncertainties, and opinions.
- Be concise and direct. Criticize the reasoning or work, not the person.

## API and Workflow diagnostic logging

- All API call chains and Workflow call chains must include structured diagnostic logs so failures can be traced end to end. Add or update this instrumentation whenever implementing or changing a chain.
- Record entry, key stages, external calls, completion, and failure with a consistent correlation ID propagated across API, service, Agent, Workflow, and background-task boundaries. Include stage, duration, outcome, and applicable task IDs and retry attempts.
- Use the validated boolean `.env` setting `VERBOSE=false` as the global switch for API and Workflow tracing and troubleshooting logs: default to `false`, enable verbose diagnostics only when `VERBOSE=true`, and respect `LOG_LEVEL`. Any chain-specific trace switch must also be gated by `VERBOSE`. Document `VERBOSE=false` in `.env.example` when implementing this configuration; do not hard-code logging switches or require source changes to enable tracing.
- Failures must preserve the original error stack and cause chain and identify the failing stage. Do not swallow exceptions or replace diagnostics with a generic retry message. Disabling verbose tracing must not suppress error logs at an enabled error level.
- Reuse the project's logging and redaction utilities. Never log API keys, credentials, session tokens, raw user conversations, preference content, or raw model payloads.
