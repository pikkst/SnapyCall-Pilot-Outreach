# RD-02 Offline HTML Evidence Coverage Matrix

Synthetic fixtures only. No real third-party personal data. Results measure current verifier contract, not production false-negative rates.

| Case | Description | Expected | Actual | Classification |
| --- | --- | --- | --- | --- |
| M1 | Labeled single named email | REVIEW_REQUIRED | REVIEW_REQUIRED | PASS |
| M2 | Generic mailbox | UNVERIFIED | UNVERIFIED | PASS |
| M3 | mailto single | REVIEW_REQUIRED | REVIEW_REQUIRED | PASS |
| M4 | Conflicting addresses | UNVERIFIED | UNVERIFIED | PASS |
| M5 | Single Person JSON-LD | {name,email} | {name,email} | PASS |
| M6 | Multi Person JSON-LD | 2 contacts | 2 contacts | PASS |
| M7 | Malformed JSON-LD | null | null | PASS |
| M8 | Oversized JSON-LD | null | null | PASS |
| M9 | Cross-domain link | UNVERIFIED | UNVERIFIED | PASS |
| M10 | Digest mismatch | n/a | NOT_MEASURABLE | NOT_MEASURABLE |
| M11 | Inaccessible source | n/a | NOT_MEASURABLE | NOT_MEASURABLE |

Synthetic corpus cannot establish historical false-negative rates without admissible stored real HTML.
