# RD-02 Offline HTML Evidence Coverage Matrix (synthetic only)

No real third-party personal data. Results measure current verifier contract, not production false-negative rates.

Measured (PASS, FP=0, FN=0):
- F1 labeled single named email
- F2 generic mailbox
- F5 single Person JSON-LD
- F6 multi Person JSON-LD
- F7 malformed JSON-LD
- F9 linked contact offline positive
- F10 linked contact unavailable

Unmeasured boundaries (NOT_MEASURABLE):
- F3 mailto: HTML normalization (no production normalization path exported)
- F4 conflicting address (requires real HTML normalization)
- F8 cross-domain link (requires real HTML normalization)
- F11 digest/readback mismatch (requires persisted evidence/readback)
