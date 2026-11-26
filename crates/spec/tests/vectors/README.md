# Vectors

Synthetic documents. The meetup, the accounts and every hash inside them are
made up; only the format is real.

- `spec.json`, `review.json`: valid documents, pretty-printed with fields out
  of order. `expected.json` has the SHA-256 of each one's RFC 8785 canonical
  form, computed with Python's
  `json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
  (JCS for these documents: ASCII keys, and no number JCS writes differently).
- `review-evidence-fetch.json`: `review.json` with `status`, `content_type` and
  `final_url` on some evidence. Those fields are optional and absent from
  `review.json`, whose hash is unchanged. Hash computed as above.
- `rejected/`: documents an implementation must refuse. Each is `spec.json` or
  `review.json` with one change, named by the file. The exception is
  `review-achieved-with-skipped.json`, which makes the failing criterion pass
  and the verdict `achieved` while one criterion stays skipped, and
  `review-achieved-with-missing.json`, which passes every criterion but lists
  a contributor whose report was never published. The reviews
  are checked against `spec.json`.
- `spec-unicode.json`: keys outside the Basic Multilingual Plane next to a
  private-use BMP key (UTF-16 order puts 😀 first; code point order would
  not), non-ASCII strings, and floats written in exponent form (`1e-7`,
  `1e+21`). Its expected hash was computed with Node (ECMAScript
  serialization and UTF-16 key order, which is what RFC 8785 specifies); the
  Python command above would get this one wrong. Node reproduces the other
  two hashes as well.
- `judge-request.json`: two deliverables, the second carrying an
  instruction to the judge, and the SHA-256 of the request body
  `judge_request` builds for them, computed with Node.
