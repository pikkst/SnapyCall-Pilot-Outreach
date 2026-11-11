# SnapyCall free-source vetting matrix — 2026-11-11

The presence of an RSS endpoint is **not permission** for automated commercial
lead collection. The current scanner remains disabled until explicit, relevant
publisher permission is verified, the robots policy allows the feed, and a
sample contains usable author evidence. Do not copy this matrix verbatim into
`DISCOVERY_FEED_URLS`.

| Candidate source | Proposed URL | Status for automatic prospect collection | Rationale |
| --- | --- | --- | --- |
| n8n Community | https://community.n8n.io/latest.rss | **BLOCKED** | [n8n's 2026 help center](https://support.n8n.io/article/ai-agents-and-automated-access-to-the-n-8-n-community) explicitly disallows automated monitoring or collecting names for commercial databases; forum users are not necessarily consultants |
| Make Community | https://community.make.com/latest.rss | **BLOCKED** | [Community ToS](https://community.make.com/tos) explicitly forbids automated forum monitoring and collecting personal information for commercial lists |
| Consulting Success | https://www.consultingsuccess.com/feed | **BLOCKED** | [Terms of Use](https://www.consultingsuccess.com/terms-of-use-page) restrict unauthorized content collection and commercial use |
| Duct Tape Marketing | https://ducttapemarketing.com/feed/ | **REVIEW_REQUIRED** | [Independent feed index](https://feeder.co/discover/d1827cd7d9/ducttapemarketing-com) reports an active RSS; individual authorship and publisher permission for commercial prospect use are unverified |
| Kashbox Coaching | https://kashboxcoaching.com/feed | **REVIEW_REQUIRED** | [Coaching RSS directory](https://rss.feedspot.com/coaching_rss_feeds/) lists it, but no authoritative permission or usable author sample verified |
| Animas Coaching | https://www.animascoaching.com/feed | **REVIEW_REQUIRED** | Feed candidate unverified; blog bylines may be professional writers rather than service providers |
| Marketing Insider Group | https://marketinginsidergroup.com/feed | **REVIEW_REQUIRED** | Feed and publisher permission require a live check |
| Consultant Journal | https://consultantjournal.com/feed | **REVIEW_REQUIRED** | Feed, terms and author quality require a live check |

### What has actually been established?

- Web retrieval of the first two feed URLs reports RSS media type, but this
  environment cannot inspect the RSS body itself.
- Another RSS URL was rate-limited (HTTP 429); several other URLs were not
  retrievable in this environment. **No complete, verified live sample** was
  obtained. An RSS listing by itself is not a confirmed working integration.
- Official n8n and Make rules explicitly disallow our intended automated
  commercial collection use; hard-block those domains in code.
- No real candidate was harvested, imported or contacted.

### Approval gates for each new source

1. Confirm permitted use for **commercial candidate identification**, not just
   ordinary RSS reading or viewing.
2. Verify URL response, status, media type, robots policy, and stable author
   fields from the *actual Render egress network* without bypassing restrictions.
3. Check whether authors are identifiable consulting professionals vs.
   anonymous forum users or editorial staff.
4. Limit volume and retention; store only minimum useful metadata, provenance,
   original URL and timestamp.
5. Record permission/reference evidence and an approval decision before
   putting its URL in `DISCOVERY_FEED_URLS`.
6. Re-evaluate if publisher policy, feed structure or access status changes.

The product's manual web-search links remain usable for human research.
The automatic RSS scanner requires its own explicit source authorization.
