# RD-02 Offline HTML Evidence Coverage Matrix (synthetic only)

No real third-party personal data. Results measure current verifier contract, not production false-negative rates.

| Case | Description | Expected | Actual | Classification |
| --- | --- | --- | --- | --- |
| M1 | Labeled single named email | REVIEW_REQUIRED | REVIEW_REQUIRED | PASS |
| M2 | Generic mailbox | UNVERIFIED | UNVERIFIED | PASS |
| M3 | Visible mailto anchor text | REVIEW_REQUIRED | REVIEW_REQUIRED | PASS |
| M4 | Conflicting addresses | UNVERIFIED | UNVERIFIED | PASS |
| M5 | Single Person JSON-LD | object | object | PASS |
| M6 | Multi Person JSON-LD | 2 | 2 | PASS |
| M7 | Malformed JSON-LD | null | null | PASS |
| M8 | Oversized JSON-LD | null | null | PASS (boundary) |
| M9 | Cross-domain link | UNVERIFIED | UNVERIFIED | PASS |
| M10 | Linked contact offline positive | evidence | evidence | PASS |
| M11 | Linked contact unavailable | linkedUnavailable=true | true | PASS |
| M12 | Digest/readback boundary | NOT_MEASURABLE | NOT_MEASURABLE | NOT_MEASURABLE |

FP=0, FN=0 on synthetic corpus. M8/M12 boundaries documented, not counted as tested coverage.
