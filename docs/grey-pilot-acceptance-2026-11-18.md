# Grey pilot handoff — staging acceptance (2026-11-18)

This is a **release gate**, not evidence that these steps have passed. Do not describe the pilot as end-to-end complete until the authenticated browser checks below have succeeded against the deployed exact main commit.

## One-time setup (partner account)

1. Open https://pilot.eventnexus.eu in a normal browser session and sign in with the invited Google identity.
2. Verify that **Partner** access (not Admin) and the intended workspace are selected. No other partner's contacts or settings should appear. Open a second browser session as another partner and confirm isolation.
3. Open AI settings, select **Gemini / gemini-2.5-flash**, save the partner's own API key, and confirm the encrypted key's configured status without exposing its value again.
4. Set a **monthly application research budget** and task/day limits. The USD application ledger is conservative, **not** the Google AI Studio bill or prepaid balance. Do not ask Grey to raise the budget just because the app reserved a worst-case ceiling.
5. Confirm source/grounding and public-email inspection feature availability. If their server flags are OFF, the dashboard must visibly report them as unavailable; do not imply that source-to-email enrichment can run.

## Unified Research workspace UI contract (Grey pilot)

1. Enter **Research / Find experts**, choose **One search** (up to 20 cited candidates) or **Campaign** (100 cited-candidate target) without navigating to a separate dashboard-only workflow.
2. Check the same readiness state in both modes. Configure the personal AI adapter first; save the monthly USD *application* budget and attempt limits before any paid execution. Missing requirements should link to AI settings. Planning a 100-target campaign is free and must not issue a paid provider request.
3. When changing between modes, criteria should be copied into the campaign editor subject to its 240-character server contract; changing campaign criteria must preserve the current text and invalidate the old create-idempotency key. A planned campaign is still inert until an explicit, separately capped paid approval.
4. Review existing campaigns, their persisted progress and contact-evidence stages in the **same Research workspace**. A sourced observation is not a named email or usable contact.
5. Confirm Google Sheets and Gmail are **optional follow-on integrations**. Google Forms/Sheets currently has read-only consent but no active sync, and Gmail sending remains disabled. Neither is required to configure paid research.
6. Inspect phone and desktop layouts, keyboard focus on both mode buttons, separate campaign status/error states, long criteria and slow read-only progress fetches. Confirm switching workspaces cannot show a stale previous workspace's results.

## Single-run pilot acceptance

1. Start with a small new research campaign (e.g., 5–10 public professionals) using an explicit narrow request and approved conservative attempt cap. Avoid a 100-contact paid campaign for initial smoke.
2. Confirm there is exactly **one** user approval for the run; the app shows provider, model, upper-bound USD commitment, task cap and stop control. No outreach is authorized.
3. Observe completed task count, saved cited observations, pending/blocked status and costs. Reload and open the same campaign in another tab; state must originate from the server, never from a stale browser counter.
4. Verify a terminal Gemini `STOP` response lacking cited grounding, if encountered, is stored as **COMPLETED with zero evidence**, visible as an uncited completion and charged at the conservative ceiling. It must not generate a contact, trigger the same paid call again, or require manually skipping an uncertain task.
5. Separately test a **network timeout or unknown billing outcome** using a deterministic staging test fixture, not a live paid retry. It must remain PAUSED/RECONCILIATION_REQUIRED with no automatic replay or budget refund.
6. Try Stop during a run. No new provider request may be started after stop; the in-flight request may finish. Reload and verify the durable state.
7. For a terminal research campaign, review the Source Resolution Agent. Running it requires explicit approval and a server-enabled flag; source hints are not verified identities. Do not use 233 historic citations as a free-form smoke batch.
8. A source hint may progress through independently constrained public-page/robots/DNS checks and exact named email evidence review only when those stages are enabled and independently authorized. A shared directory, generic mailbox, or missing email must never create a contact.
9. Any saved candidate must have **name + category + specific evidence-backed email**, linked original citation, explicit review and no automatic sending. Verify manual review separately from discovery.
10. Confirm sign-out, session isolation, duplicate-click idempotency, expired approval, reload and mobile layout.

## Shipping / rollback gates

- PR exact-HEAD CI and PostgreSQL upgrade/clean-start smoke successful.
- Render release exact commit LIVE; app starts; new deploy does not change feature flags or start paid work.
- Verify real staging OAuth + partner workspace and the one-run test with owner present.
- Keep **AI_GROUNDING_RESOLUTION_ENABLED**, **AI_EMAIL_TRIAGE_ENABLED** and autonomous paid run flags OFF until the individual stages' readiness, legal source access and authenticated pilot smoke are confirmed.
- If the deployed test fails, revert the release to the last verified commit and stop new research authorization; never reset historical spend, re-run uncertain paid tasks or erase evidence to make the UI look green.

## Known non-goals of the no-grounding fix

- It does not retroactively change PAUSED/CANCELLED tasks or reconcile prior billing.
- It does not make Render Free an always-on worker.
- It does not magically turn provider citation hints into confirmed email contacts.
- It does not certify Google's invoice or initiate any outbound email.
