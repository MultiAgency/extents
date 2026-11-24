# outlayer-attestation

Checks the attestation of one run of a program on [OutLayer](https://outlayer.ai)'s testnet,
such as a run of [`outlayer-evaluator`](../outlayer-evaluator). An experiment: nothing else in
the repository depends on it.

```sh
cargo run --release -- <tx hash> <tx signer> <wasm file>
```

`<tx hash>` is the `request_execution` transaction on `outlayer.testnet`, as the e2e's
`outlayer-evaluator` scenario prints it for each run, and `<wasm file>` is the program it ran.
It prints the wasm's hash, the input and the output, then each check, and ends with
`VERIFIED`, or fails naming the check that did not hold.

## What it checks, and from where

| Check | Source |
| --- | --- |
| The request ran this wasm, by hash, on this input, and returned this output. | The transaction, from a NEAR RPC. |
| The attestation names the same wasm, input, output and caller. | OutLayer's API, compared with the above. |
| The quote is signed up to Intel's root, on a platform that is `UpToDate` with no advisories, and the enclave is not in debug mode. | The quote from OutLayer's API; the collateral from Intel's provisioning service; Intel's root certificate as compiled into [`dcap-qvl`](https://github.com/Phala-Network/dcap-qvl). |
| The quote's report data is the hash of this task's fields, and nothing else. | Recomputed here, as [`WORKER_ATTESTATION.md`](https://github.com/out-layer/outlayer/blob/main/WORKER_ATTESTATION.md) defines it. |
| The worker build's five measurements are approved. | `is_measurements_approved` on `worker.outlayer.testnet`. |

Only the quote comes from OutLayer, and a quote cannot be forged without Intel's keys.

## What a pass shows

An approved worker build, in a genuine TDX enclave, attested that it ran exactly this wasm on
this input and got this output.

For the run that asks the evaluator program for its account, that ties the wasm's hash to the
account an objective names as `evaluator`. For a run that judges, it ties one verdict, with
its review and signed intent, to the program and the input it was given.

## What it does not show

- **That the approved build is honest software.** The measurements are compared with a list,
  not with a build of OutLayer's published source. Whoever governs the list
  (`dao.outlayer.testnet`, with `owner.outlayer.testnet` able to revoke) decides what runs.
  Ten builds were approved on testnet when this was written; any of them can attest.
- **That the key is used only by this program.** The key is issued by OutLayer's keystore,
  another enclave, which takes the wasm's hash on the word of the worker's session. Nothing
  here checks the keystore. A verdict signed without a matching attested run would still be
  accepted on chain; it could be noticed afterwards, because no attestation of it would
  verify, but not prevented.
- **That the wasm is built from this source.** The program's build is not reproducible.
- **That an old run still verifies.** The quote is checked against Intel's collateral as it
  is today. When Intel retires a platform's security level, a run attested under it stops
  passing here, though it was sound when it ran. OutLayer serves the collateral of the time
  at `/public/collateral`, which this tool does not use.
- **Anything about mainnet.** The contract accounts and API are testnet's.
