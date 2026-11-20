import { expect, test } from "vitest";
import { findFiled } from "../src/web/dao-proposal.ts";
import { attestProposal } from "../src/shared/attest.ts";

// A filing's wire shape is independent of the review used to build its arguments.
type Filing = ReturnType<typeof attestProposal>;
const action = { method_name: "ob_attest", args: "e30=", gas: "90000000000000", deposit: "0" };
const kind = { FunctionCall: { receiver_id: "objective.testnet", actions: [action] } };
const filing: Filing = { proposal: { description: "Attest", kind } };

test("only proposals carrying the complete requested action prevent another filing", async () => {
  const variants = [
    { ...action, gas: "1" },
    { ...action, deposit: "1" },
    { ...action, args: "other" },
    { ...action, method_name: "ob_close" },
    action,
  ];
  const proposals = variants.map((a, id) => ({
    id,
    status: "InProgress",
    kind: { FunctionCall: { ...kind.FunctionCall, actions: [a] } },
  }));
  const reader = {
    async view<T>(_dao: string, method: string): Promise<T> {
      return (method === "get_last_proposal_id" ? proposals.length : proposals) as T;
    },
  };
  expect(await findFiled(reader, "dao.testnet", filing)).toEqual([4]);
});
