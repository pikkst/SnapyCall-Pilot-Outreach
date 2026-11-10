# SnapyCall Pilot Outreach

Private, independent pilot-expert acquisition workspace for SnapyCall.

## Scope
- Find and qualify English-speaking online experts in AI/no-code, coaching, marketing/growth and business strategy.
- Prioritize US (40%), UK/Ireland (40%), other English-speaking markets (20%); geography is a ranking preference, not a hard filter.
- Track candidate source, evidence, outreach eligibility, draft approval, responses and the separate application/acceptance outcome.
- Invite candidates to the approved SnapyCall Pilot Expert Application form: https://forms.gle/5xGr5SbFAknhomTb6
- Start in **draft-only** mode. No automated email, scraping, CRM integrations or external writes in the first milestone.

## Constraints
- Do **not** use `gary.ljamin@snapycall.com` or SnapyCall's production notification infrastructure for outreach.
- `gary@snapycall.com` may be listed in a signature only with appropriate authorization; it is **not** an authorized From identity.
- No bulk harvesting or outreach solely because a profile is public.
- No secrets, contact lists, or production credentials in Git.
- Never run demo seeds or send emails as part of CI.

## Implementation plan
1. Define typed candidate and qualification contracts, import validation and deterministic ranking.
2. Add PostgreSQL + Prisma with immutable provenance, deduplication, consent/legal basis and audit trails.
3. Add authenticated admin UI and draft review.
4. Integrate a separate authorized sender with suppression, unsubscribe, idempotency, limits and explicit enablement.
5. Import approved partner/expert lists only after privacy and source review.

See `docs/architecture.md` for domain contracts and rollout gates.
