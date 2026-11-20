# Reading an objective's record

This repository has no reputation service or score. An external reader can derive a record from
`funded`, `committed`, `delivered`, `resolved`, `paid`, `lost` and `cleanup` events.

A resolved outcome records allocation; `paid` records completed transfers. An accepted outcome
records silence under the agreed acceptance window, not an evaluator's positive verdict.
A delivery hash records a commitment, not the quality or truth of the work.

The app publishes reports and reviews as public plaintext (documents.md). It verifies a report
against its finalized delivery transaction and a review against the committed spec. It does not
support encrypted reports or an attested evaluator.

Distinct account ids do not establish independent parties. The sponsor may also be the evaluator;
the evaluator cannot be a contributor or backup. Accounts controlled by one person can still
inflate an apparent track record. Event counts alone cannot establish reputation.
