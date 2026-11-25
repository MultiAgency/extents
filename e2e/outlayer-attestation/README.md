# outlayer-attestation

Checks the attestation of one run of a program on [OutLayer](https://outlayer.ai)'s testnet,
such as a run of [`outlayer-evaluator`](../outlayer-evaluator). An experiment: nothing else in
the repository depends on it.

```sh
cargo run --release -- <tx hash> <tx signer> <wasm file> [<worker file>]
```

`<tx hash>` is the `request_execution` transaction on `outlayer.testnet`, as the e2e's
`outlayer-evaluator` scenario prints it for each run, and `<wasm file>` is the program it ran.
`<worker file>`, optional, is the worker's entry in a node's `cvms` at
`https://workers.outlayer.ai/api/attestation`, saved as served. The portal lists running
workers only and drops one once its release retires, so save it beside the run.
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
| With a worker file: each RTMR3 event's digest is of its name and payload, the events replay to the quote's RTMR3, the app-compose hashes to the compose hash they name, and every image it runs is pinned by digest. | The event log and app-compose from OutLayer's portal, checked against the verified quote. |

What comes from OutLayer is checked before it counts: a quote cannot be forged without
Intel's keys, and a worker file counts only once its events replay to the quote.

## What a pass shows

An approved worker build, in a genuine TDX enclave, attested that it ran exactly this wasm on
this input and got this output.

For the run that asks the evaluator program for its account, that ties the wasm's hash to the
account an objective names as `evaluator`. For a run that judges, it ties one verdict, with
its review and signed intent, to the program and the input it was given.

With a worker file, it also names the release that build is: the app-compose that ran, and
the images it runs, by digest. A worker has no instance id, so one release has one RTMR3.

## What it does not show

- **Which release, without a worker file.** The measurements are then only compared with a
  list. Whoever governs the list (`dao.outlayer.testnet`, with `owner.outlayer.testnet` able
  to revoke) decides what runs; ten builds were approved on testnet when this was written,
  and any of them can attest.
- **Where an image was built.** The tool prints each image with the command that checks its
  provenance, `gh attestation verify oci://<image> -R out-layer/outlayer`, which ties it to a
  tag and commit of OutLayer's source. Whether that source is honest is a review of it.
- **That the key is used only by this program.** The key is derived from OutLayer's master
  and the wasm's hash, and issued by its keystore, another enclave, which takes that hash on
  the word of the worker's session. Nothing here checks the keystore. While the keystore DAO
  carries a full-access key, its holder can obtain the master outside any enclave
  ([Governance at this stage](https://github.com/out-layer/outlayer/blob/ce9b21590a24d4600a80dd1a666793e54a8757b1/docs/NON_CUSTODIAL.md#governance-at-this-stage)),
  and with it this key. A verdict signed without a matching attested run would still be
  accepted on chain, since the objective pays on the signature with no window before payout;
  it could be noticed afterwards, because no attestation of it would verify, but not
  prevented.
- **That an old run still verifies.** The quote is checked against Intel's collateral as it
  is today. When Intel retires a platform's security level, a run attested under it stops
  passing here, though it was sound when it ran. OutLayer serves the collateral of the time
  at `/public/collateral`, which this tool does not use.
- **Anything about mainnet.** The contract accounts and API are testnet's.
