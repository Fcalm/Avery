---
name: job-application
description: Complete an authorized application only through a company-specific career site or ATS flow. Use for employer application forms, uploads, and submission; do not use for third-party recruiting platforms such as BOSS Zhipin, Liepin, Zhaopin, 51job, or LinkedIn.
metadata:
  avery:
    scenarios:
      - application
---

# Job application

Use this skill only for a named employer's own career site or its dedicated ATS application flow. A vendor-hosted ATS page reached from the employer's recruitment flow remains in scope even when its domain is not owned by the employer.

Do not use this skill on multi-employer recruiting marketplaces or social recruiting platforms, including BOSS Zhipin, Liepin, Zhaopin, 51job, and LinkedIn. For BOSS Zhipin applications, use `boss-deliver-workflow` instead.

Load `company-career-form` first for a structured career-site or ATS form and follow its profile-driven batch workflow.

1. Read the job requirements and the authorized resume, profile, and attachments before applying. Confirm that the target role and selected materials correspond.
2. Observe and fill the real company application page with browser tools. Refresh the page snapshot after navigation, clicks, or page transitions.
3. Hand login, CAPTCHA, unresolved authorization, and identity verification back to the user.
4. Upload only Host-authorized file identifiers. Never request or infer a physical file path.
5. Agreement acceptance, sensitive-file uploads, and final submission must follow the current confirmation policy and tool results.
6. Stop after `STATUS_UNKNOWN` and do not resubmit. Only a successful tool receipt proves completion.

Before final submission, load `references/submission-checklist.md` when a checklist is needed.
