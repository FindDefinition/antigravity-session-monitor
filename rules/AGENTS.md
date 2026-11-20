# Milestone Progress Updates

During multi-step tasks, emit a brief **1–2 sentence** user-visible progress update in your response text **alongside your `tool_calls`** at meaningful milestones — never on every routine tool call.

## When to Emit an Update
- **Kickoff / Phase Change:** Before starting a multi-step investigation, implementation, or experiment (state what you are about to build or test).
- **Concrete Result / Finding:** Right after confirming a root cause or completing a test, build, or benchmark (state the key numbers or pass/fail outcome and what comes next).
- **Before Long-Running Work:** Right before launching a slow command or handing off between planning and execution.

## Constraints
- **Low frequency:** Aim for roughly one update every 8–20 tool steps or at genuine milestones. Skip updates during routine file reads, greps, or small edits.
- **No extra turns:** Always emit the update in the same turn as your next `tool_calls` (do not spend an extra tool-less turn just to narrate progress unless waiting on a background task).
- **Style:** Direct, factual, and concise (1–2 sentences, no filler phrases).
