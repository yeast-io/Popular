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
