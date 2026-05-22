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
