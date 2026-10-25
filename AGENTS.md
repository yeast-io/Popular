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

## File and directory naming

- Use lowercase kebab-case for directories and business-name segments, grouping files by feature and responsibility. Keep model decisions in `agents/` and persistence implementations under `infrastructure/`; do not create generic `types/`, `interfaces/`, or `utils/` directories merely to separate file kinds.
- Name backend TypeScript files `<business-name>.<role>.ts`, joining business words with hyphens and reserving dots for role, test, and extension suffixes. For example, use `assistant-session.types.ts`, not `assistant.session.ts`. Preserve framework-required filenames and the existing PascalCase convention for Vue components.
- Put all named interfaces, type aliases, and storage contracts in `*.types.ts`, including private types currently used by only one implementation. This applies to backend modules, infrastructure, frontend TypeScript, and Vue scripts, not just Workflows. Use type-only imports and exports. Put initialization functions and business invariants in `*.domain.ts`, policy constants in `*.policy.ts`, and runtime validation in `*.schema.ts`; do not mix runtime initialization into a type-definition file.
- Choose role suffixes that describe the actual responsibility: `*.agent.ts`, `*.workflow.ts`, `*.tool.ts`, `*.service.ts`, `*.worker.ts`, `*.routes.ts`, `*.store.ts`, `*.domain.ts`, `*.policy.ts`, `*.schema.ts`, `*.presentation.ts`, `*.messages.ts`, `*.errors.ts`, or `*.prompts.ts`. Create only the files the feature needs; do not add empty layers for naming symmetry.
- Reserve `service` for application-level interfaces that serve user-facing use cases. Under `infrastructure/`, name new files and classes by their technical responsibility, such as `store`, `client`, `adapter`, or `connector`; avoid `service` there unless a framework requires that name. Do not mass-rename existing files for this convention alone.
- Keep tests beside their implementation as `<business-name>.<role>.test.ts`. When moving, splitting, or renaming a file, update imports, tests, documentation links, and directory trees together. Apply these rules to new files and the explicitly scoped refactor; do not mass-rename unrelated existing files.

## Schema, model, and store boundaries

- Define runtime validation schemas in `<business-name>.schema.ts`. Define Mongoose schemas, indexes, schema hooks, and model factories in the matching schema file under `infrastructure/mongodb/<feature>/`; never construct schemas or register models inside a store, service, route, Agent, Workflow, or server assembly file.
- Keep `<business-name>.store.ts` limited to persistence operations and document/domain mapping. Import its model type or factory type from the matching schema module; obtain actual models through dependency injection. Put shared storage contracts in the feature's `*.types.ts`, not in the store implementation.
- Keep queue contracts, execution contexts, options, callbacks, and named action/result types in the feature's `*.types.ts`, even when only one implementation currently consumes them. Do not declare named interfaces or type aliases in implementation modules or Vue scripts. Test-local fixture types and framework ambient declaration files may remain with their test/declaration context.
- Keep shared, independently consumed type/interface definitions in `*.types.ts`, without executable values or initialization. Schema-derived types such as `Static<typeof Schema>`, `z.infer<typeof Schema>`, Mongoose document types, and model factory return types may stay beside the schema they describe; do not duplicate the schema's source of truth just to separate these dependent types.
- Schema modules may compose other schema modules but must not execute business workflows, access credentials, perform queries, or import store implementations. Business initialization and pure domain operations belong in `*.domain.ts`; provider errors and other executable classes must use an appropriate implementation module rather than `*.types.ts`.
- When correcting these boundaries, preserve model and collection names, fields, defaults, indexes, validation behavior, and persisted data formats. Update every consumer and split schema-focused tests from store-operation tests where necessary. Scan first and change actual responsibility violations; retain framework entrypoints and dependency-driven composition modules such as `models.ts`.
- The `markdown` files are only allowed to create in directory `docs`.

## Localization

- All user-facing features must support both English (`en-US`) and Simplified Chinese (`zh-CN`).
- Keep all user-facing text in dedicated localization resources or presentation modules. Never hardcode user-facing text in business logic, API handlers, Agents, or Workflows.
- Use the resolved locale consistently for prompts, validation messages, errors, labels, and status names. Language-neutral follow-ups must retain the conversation's locale; use the configured default only when no locale is available.
- Verify both languages when adding or changing user-facing behavior.

## API and Workflow diagnostic logging

- All API call chains and Workflow call chains must include structured diagnostic logs so failures can be traced end to end. Add or update this instrumentation whenever implementing or changing a chain.
- Record entry, key stages, external calls, completion, and failure with a consistent correlation ID propagated across API, service, Agent, Workflow, and background-task boundaries. Include stage, duration, outcome, and applicable task IDs and retry attempts.
- Use the validated boolean `.env` setting `VERBOSE=false` as the global switch for API and Workflow tracing and troubleshooting logs: default to `false`, enable verbose diagnostics only when `VERBOSE=true`, and respect `LOG_LEVEL`. Any chain-specific trace switch must also be gated by `VERBOSE`. Document `VERBOSE=false` in `.env.example` when implementing this configuration; do not hard-code logging switches or require source changes to enable tracing.
- Failures must preserve the original error stack and cause chain and identify the failing stage. Do not swallow exceptions or replace diagnostics with a generic retry message. Disabling verbose tracing must not suppress error logs at an enabled error level.
- Reuse the project's logging and redaction utilities. Never log API keys, credentials, session tokens, raw user conversations, preference content, or raw model payloads.
