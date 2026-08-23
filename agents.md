# Agents & Workflow

## Workflow Documentation

All agents should follow the "Micro-Task Workflow" to maintain high reliability and prevent looping.

### Micro-Task Workflow

1.  **Create/Update `work-status.md`**: Before starting any work, ensure `work-status.md` exists in the root.
2.  **Document State**: The `work-status.md` must contain:
    - **Goals**: High-level objectives.
    - **Current Status**: What is done, what is in progress.
    - **Next Tiny Task (Focus)**: The single, smallest possible next step.
    - **Review of Process & Blockers**: What went wrong and what was learned.
    - **Action Plan (Iterative)**: The roadmap.
3.  **Execute Micro-Task**: Focus ONLY on the "Next Tiny Task".
4.  **Update Status**: After completing a micro-task, immediately update `work-status.md`.
5.  **Re-read & Repeat**: Re-read `work-status.md` before the next step to ensure continuity.

### Important Files
- `work-status.md`: The single source of truth for the current task state.

### Lessons Learned & Best Practices

- **Verification Strategy**: When testing complex asynchronous or streaming logic, avoid creating "shadow" implementations of the main application architecture within the test. This creates maintenance overhead and TypeScript friction. Instead, use a sequence-based approach to test the core logic units with inputs that simulate the stream's effects.
- **Complexity Management**: If a test begins to fail due to TypeScript errors or complexity, do not attempt to "patch" the test implementation. Re-evaluate the test design and simplify the verification target.
- **Status Maintenance**: Always maintain `work-status.md` to prevent loops and ensure context is preserved during handoffs or interruptions.

## Mandatory Learning Log

- Maintain the repository-wide append-only learning collection in `docs/leanings/`.
- Create exactly one Markdown file per learning in the same change whenever work reveals a resolved bug or regression, failed or misleading experiment, unexpected behavior, setup or environment trap, non-obvious constraint, important workaround, or rejected approach with reusable rationale.
- Routine successful work does not need an entry unless it produces a reusable insight.
- Follow the filename convention and exact entry structure documented in `docs/leanings/README.md`. Include the task/context, observation or failure, evidence, approaches tried and their outcomes, root cause, resolution, verification, prevention or follow-up, and the reusable learning.
- Mark uncertainty honestly. If root cause or resolution is incomplete, record the entry as `Partial` or `Open` and state what evidence is still missing.
- Keep learning files append-only by default: do not delete or rewrite older files merely to make the history cleaner. Put later discoveries in a new file that links the earlier learning.
- Exception for confirmed falsehoods: when authoritative evidence proves that an entry itself was fabricated, hallucinated, or factually false, correct or remove the false content so future agents do not reuse it.
- A confirmed-falsehood correction must never be silent. Mark the affected file `Corrected` and add a dated correction note stating what was wrong, the authoritative evidence used, and what was changed. Do not repeat removed sensitive content.
- If the evidence is incomplete or disputed, do not rewrite the original file; add a dated `Partial` or `Open` learning file that links it.
- Link relevant issues, commits, logs, or regression tests when safe and useful.
- Never place credentials, tokens, private keys, customer data, sensitive payloads, or unsanitized production evidence in learning files.
