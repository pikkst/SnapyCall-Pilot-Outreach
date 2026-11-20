# AI98 RD-02 Source Yield Root-Cause Audit

## Scope and authorization

This report is an offline/code audit on `main` after RD-01D merge. The CTO
approved code analysis, synthetic HTML/JSON-LD fixtures, and preparation of a
future read-only audit, but did not authorize access to `snapycall_pilot` or
any staging/production campaign. The reported 17-observation campaign is
therefore owner-reported input, not an independently reconciled database
finding.

No provider calls, paid research, database writes, contact creation, or source
access were performed.

## Current pipeline

The existing flow is:

`ResearchCampaignObservation` → deterministic person-source plan → immutable
person-source approval/job snapshot → owner budget/quota/lease claim → bounded
provider-cited source hints → HTTPS/robots/SSRF-safe public-page inspection →
explicit named-email or structured Person evidence → independent readback and
digest/collision checks → `summarizeQualifiedEmailEvidence()`.

The source plan is observation-scoped. It deduplicates only the normalized
name, category, and exact citation URL; it never merges namesakes by name.
Source hints remain untrusted until independently inspected.

## Evidence status

| Area | Finding | Status |
|---|---|---|
| Discovery identity vs email proof | Raw observations are not qualified evidence | CODE-CONFIRMED |
| Shared source handling | Shared URLs require explicit person-scoped proof or remain ambiguous | CODE-CONFIRMED |
| Public page access | Robots, DNS, redirect, HTTP, timeout and content limits fail closed | CODE-CONFIRMED |
| Qualification | Requires complete bounded observations, valid named mailbox, source binding, digest and non-colliding email | CODE-CONFIRMED |
| Verifier false-negative rate | No independent labeled real HTML corpus is authorized or stored | UNKNOWN |
| 17-observation campaign counts | No campaign/workspace/owner scope is authorized | UNVERIFIED |
| Budget stop inputs | Cannot reconcile without the scoped campaign snapshot | UNKNOWN |

## Owner-reported campaign result

The task reports 17 persisted findings, 17 inspections, 1 source preparation,
10 source enrichment searches, zero named-email review rows, zero qualified
contacts, 8 no-attributable-email outcomes, and 9 blocked/ambiguous outcomes.
These values are retained as unverified input only. They must not be labeled
production findings until a restricted `RepeatableRead + READ ONLY` snapshot
is authorized and the existing RD-01 loader is run for one exact campaign.

## Ranked root-cause register

1. **Evidence acquisition/attribution loss — code-confirmed as the binding
   contract, not yet measured for this campaign.** Discovery and source
   search can produce people and URLs, but qualification requires an
   independently inspected, exact person-to-mailbox association. Shared or
   inaccessible sources cannot count as qualified evidence.

2. **Access and source quality loss — plausible but unconfirmed for this
   campaign.** Existing code records bounded failure outcomes and respects
   robots and public access restrictions. The earlier audit documents contain
   staging-limited robots/unavailable counts, but those counts cannot be
   transferred to the 17-observation campaign without scope confirmation.

3. **Verifier false negatives — unconfirmed.** Synthetic coverage currently
   exercises direct named email, generic mailbox rejection, single- and
   multi-Person JSON-LD, malformed JSON-LD, cross-domain mismatch, and linked
   contact success/failure. It does not establish a historical false-negative
   rate without admissible labeled source documents.

4. **Budget continuation — unconfirmed.** The implementation fences owner
   budget, daily quota, leases, immutable approval manifests, uncertain
   billing, and continuation cycles. Whether the reported stop occurred before
   eligible jobs were exhausted requires the campaign-scoped approval, cycle,
   job, reservation, and audit rows.

## Smallest justified correction

No runtime correction is justified from the currently admissible evidence.
Lowering attribution requirements, bypassing blocked pages, increasing
budgets, retrying uncertain calls, or enabling the source-resolution agent
would not be evidence-based and would weaken existing safety contracts.

The bounded next step is an authorized aggregate snapshot using the existing
RD-01 loader, followed by the offline labeled corpus audit. If that corpus
demonstrates a reproducible verifier false negative, the smallest fix is a
parser regression correction with a positive and negative fixture. Otherwise,
the result should remain diagnostic and inform a separately approved cohort
experiment.

## Required authorized follow-up

Before the historical audit, CTO must bind: database identity, restricted
read-only role, environment, workspace ID, owner ID, and campaign ID. The
audit output may contain only aggregate denominators, allowlisted reason
codes, cost states (`reserved`, `charged`, `unknown`), and reconstructability.
No emails, names, URLs, payloads, or raw contact pages may be emitted.

## Limitations and RD-03/RD-04 recommendation

The 17-result loss cannot yet be causally attributed to discovery quality,
source query targeting, repeated jobs, page accessibility, verifier behavior,
or budget termination. Do not approve a provider switch, domain/email-first
pipeline, expanded crawling, or budget change from this report. First complete
the scoped RD-01 snapshot and labeled offline coverage audit; then decide
whether RD-03/RD-04 is warranted.
