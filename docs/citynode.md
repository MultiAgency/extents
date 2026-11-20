# Extents and City Nodes

Unimplemented proposal. The current spec format has no `attendance` criterion,
and the app has no City Nodes integration. Its numeric checks read reported
figures; they do not verify attendee check-ins.

"Fund an event in NYC": the NYC community runs it, attendees check in with a QR code, and the payout releases once
enough verified check-ins are attested, judged by the parent node's DAO.

| Objective part | City Nodes |
| --- | --- |
| Contributors | The community's organizers |
| Evaluator | The parent Node's DAO, never the community's own |
| Evidence | The event's attested attendance |
| Verdict | `ob_attest`, approved by the evaluator DAO's vote |

A new criterion checks attendance:

```json
{ "kind": "attendance", "event": "citynode:<node slug>/<event id>", "attester": "<account>", "min": 30 }
```

It passes when `attester` reports at least `min` distinct check-ins at the event: either City Nodes' published count, or
check-ins each signed by the attendee and City Nodes.
