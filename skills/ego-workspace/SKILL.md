---
name: ego-workspace
description: Manage the current task workspace in Ego Lite, including recovery, handoff to the user, and retaining pages for manual submission.
metadata:
  avery:
    scenarios: [application]
---

# Ego Lite workspace

Avery chooses the browser from the user's settings and binds the task to its original workspace. Use the standard Browser tools for pages, forms, and tab switching.

- The first browser operation opens the task workspace if needed. Use `BrowserWorkspace({ action: "open" })` to prepare it explicitly. Within a task, reuse the original workspace.
- After an interruption, start with `BrowserSnapshot`. Check the live form and continue from the unfinished step. If the workspace is missing, tell the user. Do not open a replacement or replay completed or uncertain actions.
- For a manual browser step, use `BrowserWorkspace({ action: "handoff", instruction: "Describe what the user should do" })`. Wait for the user to return control. After recovery, get a fresh snapshot before using page references.
- To continue a workspace left open after handoff or completion, call `BrowserWorkspace({ action: "resume" })`. Avery verifies the original space and obtains the user's confirmation where needed.
- Use `BrowserWorkspace({ action: "keep" })` to keep the workspace at completion, including application forms the user needs to submit personally. Say which applications are ready for review or submission. Submit only when authorized by the user and the active confirmation policy.
- Use `BrowserWorkspace({ action: "close" })` only when the task workspace is no longer needed and closing it respects the user's retention preference. Preserve unfinished forms on interruption.
