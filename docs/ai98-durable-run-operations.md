# AI-98 — Durable campaign approval and guarded execution

Status: **feature-gated infrastructure; not yet a production-certified fully autonomous outreach pipeline**.

## Existing provider and research pipeline

```text
Workspace owner (Google session + active membership)
  -> POST /api/research-campaigns (deterministic 24-task plan)
  -> POST /api/research-campaigns/:id/approve-run
  -> ResearchCampaignRun [immutable provider, model, price version,
       maxTasks, worst-case cents, expiresAt=24h, status APPROVED]
  -> opted-in server poller: research-approved-runner.js (one task per tick)
  -> research-campaign-worker.js -> claimResearchTask()
       membership lock -> campaign lock -> task lease -> run allowance
       -> existing ResearchOwnerBudget / ResearchSpendMonth reservation
       -> daily quota -> provider call (Gemini/OpenAI/Anthropic BYOK)
       -> evidence insert + task CAS -> monetary settlement
  -> finishApprovedRunTask(): RUNNING / COMPLETED / PAUSED
  -> GET /api/research-campaigns/:id/approved-run (cost/status view)
  -> GET /api/research-campaigns/:id/progress (existing task status view)
```

**Existing untrusted data stages:** provider cited profiles are stored in `ResearchCampaignObservation` as `UNVERIFIED`. `server/research-observation-email.js` can inspect a public HTTPS page with SSRF/robots rules and classify explicit person-email evidence. `server/research-observation-contact-intake.js` then requires human attestation and creates a workspace Candidate with name + category + source-backed email. `ResearchCampaignSource` stores manually supplied URL inputs. **The new approved runner executes only research discovery tasks, not automated email enrichment, Sheets imports or outreach.** No email is sent.

## Authorization and billing

- Feature flag `AI_AGENT_AUTORUN_ENABLED` is **off by default**; both pre-existing research/executor flags must also be true. Merely deploying or reloading a website can never authorize spending.
- Owner grants a one-time approval specifying 1–24 research tasks and a conservative USD cents cap, with explicit consent to the worst-case cost and no automatic replay after ambiguous billing.
- At approval, provider, model and tariff version are frozen from server-owned BYOK settings and the price registry. Browser cannot supply or mutate these values.
- Approval requires a clean, not previously attempted or populated campaign. The existing 101-observation campaign cannot be silently re-executed.
- Every task claim atomically increments **monotonic conservative cost commitments** under the campaign row lock before provider dispatch. Existing monthly budget and quota are additional independent hard ceilings. Real provider invoice is NOT inferred from these commitments.
- A 24-hour expiry is checked before every paid claim. No restart, retry, web-page reload or delayed service wakeup extends the approval.
- The user may permanently stop future calls with `POST /api/research-campaigns/:id/approved-run/stop` and `{ "confirmStop": true }`. The active provider request may still be billable and is neither cancelled with a fake refund nor automatically replayed.
- `PAUSED` is fail-closed and requires review; no scheduled retry even for a chargeable timeout, task lease expiry, provider-version drift, daily/monthly limit or crash. Never patch the task `attempts` count or reserved spend manually.
- The legacy `execute-next` route is fenced from spending on a campaign with a saved `ResearchCampaignRun`; it cannot bypass the immutable approval.

## Runtime availability and monitoring

The current Render service `snapycall-pilot-outreach-staging-bax4` runs a Node web process. The new loop runs every 8 seconds **only if flag-enabled** and while the instance is running, querying persisted approved campaigns. An instance with a sleeping free web-service plan is **not an always-on worker**. Therefore do **not** enable autorun in a production workspace as a guarantee of uninterrupted one-launch completion. Provision and smoke an always-on worker or authenticated scheduled wakeup that shares this database/runner, with rate limits, isolation and monitoring; avoid creating a second billing executor.

Inspect `ResearchCampaignRun.status`, `lastCode`, `startedTasks`, `committedWorstCaseCents` and expiration, then `ResearchCampaignTask` lease state, `ResearchSpendReservation` and ledger audit events. Alert on PAUSED, expired RUNNING leases, unresolved reservations, stale progress and missing worker heartbeat (not yet implemented). A deployment should not call Gemini in its healthcheck or startup path without a previously approved campaign.

## Release gates

1. Exact HEAD CI, Node tests, TypeScript, Prisma validate, migration upgrade and clean-start CI against disposable Postgres.
2. Manual staging smoke with authenticated partner: one clean campaign approval, two tabs, abrupt process restart, user stop, expired approval, revoked membership, invalid provider key, exhausted budget, uncertainty and conflicting provider reply. No live paid test without explicit budget approval.
3. Verify the deployment has feature flag OFF initially. Deploy additive schema then code; never backfill legacy campaigns.
4. Before enabling: real always-on scheduler or worker, bounded watchdog, run cost and stage metrics, alerting, isolation and integrated email-enrichment acceptance smoke.
5. Next end-to-end stages: per-observation public email enrichment that persists review evidence, three input modes (AI/Sheets/manual URL), accepted-contact counting, UI status and export/draft gate. 100 provider observations are not 100 valid email contacts.

Related: [#98](https://github.com/pikkst/SnapyCall-Pilot-Outreach/issues/98), [architecture overview](./ai62-research-to-contact-pipeline.md).
