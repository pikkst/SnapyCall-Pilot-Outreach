# AI98: Bounded multi-source public email evidence (P1)

## Observed bottleneck
The 2026-11-19 campaign exhausted its source continuation budget with zero verified
person-email records. The old `proposedPersonSource` only accepted exactly one
unique URL for an exact named target, even when several independently cited
profiles referred to the same person.

## Contract
- One existing approved person-source job remains one potentially billable AI
  search. No new provider call, approval type, quota or cost envelope.
- Gemini 3 text-only extraction can return up to three distinct provider-cited
  exact-target source IDs from its already bounded Tavily retrieval manifest.
  The worker accepts at most three unique source URLs.
- For each URL, reuse the read-only bounded HTTPS profile retriever, including
  robots policy, pinned public DNS, strict content limits and the single
  revalidated canonical redirect from PR #169.
- Reuse `classifyExplicitPersonEmailPage`: exact named profile and exactly
  one explicitly labeled, non-generic personal mailbox on the same page.
- Skip inaccessible, unrelated or ambiguous sources. If two independently
  qualifying pages publish different mailboxes, fail closed instead of
  selecting an arbitrary address.
- Persist at most one selected URL through the **existing** source-job
  transaction, source collision checks and approval/lease fences.
- Do not persist or publish the inspected email from this helper. Downstream
  source inspection must re-fetch and independently verify before any
  reviewable email observation is committed. No contact is created, no sending
  consent is inferred, and no contact is marked ready to send.
- Once dispatched, potentially billed provider work is never automatically
  retried. Existing budget settlement and reconciliation remain unchanged.

## Operational constraints
Up to three public page reads can add latency within the existing 120-second
source-job lease. A deadline that expires during inspection is handled by the
existing fenced settlement/reconciliation path, never by replaying the paid
provider call. Failed robots/DNS/redirect checks stay terminal for that URL.
This change does not bypass blocked sources, crawl links, or guarantee yield.

## Validation
`node --test test/ai98-bounded-multi-source-email-proof.test.js`
plus full `npm test`, `npm run check`, `npm run typecheck`, and exact-HEAD CI.

## Release
Stacked on PR #169; PR #170 is an independent UX follow-up. Merge in dependency
order only after review and exact-HEAD CI. No automatic deployment or billable
test campaign. Before live measurement, verify batch-contact feature enablement
and worker/review authorization separately.
