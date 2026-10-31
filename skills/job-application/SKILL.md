---
name: job-application
description: Complete an authorized application only through a company-specific career site or ATS flow. Use for employer application forms, uploads, and submission; do not use for third-party recruiting platforms such as BOSS Zhipin, Liepin, Zhaopin, 51job, or LinkedIn.
metadata:
  avery:
    scenarios:
      - application
---

# Job application

Prefer `BrowserRunScript` to execute already-observed, already-decided browser steps sequentially and observe once at the end. Its page methods retain the original tool permissions and stop at the first failure or confirmation. Never replay completed steps after the user responds. Upload an authorized resume before filling when requested by the ATS, then observe parsing and fill in batches.

Use this skill only for a named employer's own career site or its dedicated ATS application flow. A vendor-hosted ATS page reached from the employer's recruitment flow remains in scope even when its domain is not owned by the employer.

Do not use this skill on multi-employer recruiting marketplaces or social recruiting platforms, including BOSS Zhipin, Liepin, Zhaopin, 51job, and LinkedIn. For BOSS Zhipin applications, use `boss-deliver-workflow` instead.

Load `company-career-form` first for a structured career-site or ATS form. Use `BrowserUploadFile` with `purpose:"resume"` before filling, observe `readyForFill` (resume parsing can overwrite controls), then follow `BrowserFillForm(plan) → Agent source matching → BrowserFillForm(execute) → BrowserValidateForm → targeted corrections → BrowserValidateForm`. Observe the same pending upload through `BrowserWait(kind:resume_parse,value:settled)` without re-uploading. Match parser values using authorized facts; protect or restore pre-upload values according to the plan's correctionPolicy. Use returned observedOptions before reopening a failed select. Do not replace the batch with per-input fill-and-Enter calls or snapshots.

1. Read the job requirements and the authorized resume, profile, and attachments before applying. Confirm that the target role and selected materials correspond.
2. Observe and fill the real company application page with browser tools. After navigation or an action that invalidates references, obtain `BrowserSnapshot({})` before the next reference-based action. Merge `delta` results into the previous view and retain that view on `unchanged`, always using the returned current `pageRevision`. Request full mode only when the baseline is unavailable or cannot be reconstructed reliably.
3. Hand login, CAPTCHA, unresolved authorization, and identity verification back to the user.
4. Upload only Host-authorized file identifiers. Never request or infer a physical file path.
5. Agreement acceptance, sensitive-file uploads, and final submission must follow the current confirmation policy and tool results.
6. Stop after `STATUS_UNKNOWN` and do not resubmit. Only a successful tool receipt proves completion.

Before final submission, load `references/submission-checklist.md` when a checklist is needed.
