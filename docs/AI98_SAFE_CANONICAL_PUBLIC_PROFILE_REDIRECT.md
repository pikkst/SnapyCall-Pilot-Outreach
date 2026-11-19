# AI98 public profile canonical redirect handling

## Motivation / historical evidence

The 2026-11-19 controlled run (8 discovery + 12 source calls,
`cmwnbr57v0001ct3jm1ivp3ns`) produced zero independently qualified
person-email pairs. Seven source pages could not be inspected; three
had `PUBLIC_PAGE_REDIRECT_REJECTED` (three more had robots denial and
one another access failure). Those outcomes do **not** prove the
redirect targets contain named emails.

The earlier read-only adapter rejected *every* 3xx response even when
a public biography URL only needed a canonical trailing slash or
`www`/apex redirect.

## Bounded correction

Keep the existing `retrieveCitedPublicPage` and its pinned HTTPS
transport; do not create another crawler. The transport reports a
3xx status and Location but never follows it itself.

For a public provider-cited HTTPS profile URL, the reader may
resolve **one** canonical 301, 302, 307 or 308 redirect if:
- both URLs pass `publicCitationUrl` (HTTPS only, no port,
  credentials, IP-literal or internal host);
- the host remains the exact same hostname or its `www.` equivalent
  (not another subdomain or external origin);
- the result is not the identical URL / a redirect loop;
- the destination independently passes a second robots.txt check,
  fresh public DNS validation and pinned page HTTPS request;
- any second redirect, robots redirect, invalid MIME, body over 128 KiB,
  unsupported encoding, DNS failure, or unsafe target fails closed.

The public person-email evidence classifier still requires the exact
original provider-cited profile URL and a publisher-visible
`Name:`/person-heading + uniquely labeled mailbox; the original URL
remains the auditable evidence link and resolves to the inspected
canonical page. No email inference, blind domain crawling, contact
creation, quota expansion, billable retry or sending is introduced.

## Scope and verification

Tests cover canonical trailing-slash and same-site www redirects,
robots recheck, fresh DNS pinning, second-hop rejection, external and
private hosts, userinfo/ports/HTTP downgrades, and the existing
review-only person-email classifier.

This does not resolve websites intentionally blocked by robots.txt or
support multi-source official-domain exploration. That larger
enhancement needs a separate deterministic source-attribution contract
and approval-bounded workload design.

Do not replay the completed historical campaigns. Release requires
exact-HEAD CI and a normal PR review; authenticated live smoke follows
merge/deploy only on explicit authorization.
