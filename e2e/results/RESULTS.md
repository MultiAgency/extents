# Historical testnet results

The checked-in transaction dumps were removed because individual records did not identify their
contract build. They must not be used as evidence for the current WASM. Dated observations and
transaction links remain in `../README.md` as historical notes.

New scenario runs record the objective WASM SHA-256 and pinned Verifier SHA-256 and write to
`<results>/<objective-wasm-sha256>/`. DAO-only records use `<results>/dao/`. Each directory has its
own generated RESULTS.md; generated directories are ignored by Git.
