/**
 * Extents for other agents, over MCP: the same tools the customer agent
 * uses, plus drafting an objective and evaluating one, each down to its
 * exact unsigned transactions. Agents prepare; only wallets and DAOs sign.
 */
import { EventType, type RunErrorEvent, type RunFinishedEvent } from "@ag-ui/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { attestationOf, type Dao } from "../shared/attest.ts";
import { calls, describe } from "../shared/calls.ts";
import { objectiveCodeHash, TOKEN } from "../shared/config.ts";
import { buildObjective, proposal } from "../shared/objective.ts";
import { randomSalt, type Params } from "../shared/params.ts";
import { accountId, type Review } from "../shared/spec.ts";
import { abortable, RUN_MS, withTimeout } from "./bounded.ts";
import { runEvaluation, type CheckRunDeps } from "./precheck.ts";
import { SERVER_TOOLS } from "./tools.ts";

export interface McpDeps extends CheckRunDeps {
  deploy(params: Params): Promise<{ accountId: string; txHash?: string }>;
  /** Spends one costly operation from the service's allowance, or returns why it can't. */
  charge(): string | undefined;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) }],
});

/** The evaluation's final result, or its refusal, from the same run the evaluator's page streams. */
async function evaluate(objective: string, deps: CheckRunDeps) {
  const input = {
    threadId: "mcp",
    runId: crypto.randomUUID(),
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { objective },
  };
  for await (const e of runEvaluation(input, deps)) {
    if (e.type === EventType.RUN_FINISHED) return (e as RunFinishedEvent).result as { review?: Review } & Record<string, unknown>;
    if (e.type === EventType.RUN_ERROR) return { error: (e as RunErrorEvent).message };
  }
  return { error: "The evaluation ended without a result." };
}

/** A tool error when the service's allowance for costly work is spent. */
function spending(deps: McpDeps) {
  const reason = deps.charge();
  return reason ? { isError: true, content: [{ type: "text" as const, text: reason }] } : undefined;
}

const PUBLISH_NOTE = "Its receipt fails by design (the objective has no such method); FastData indexes the call anyway.";

function createServer(deps: McpDeps): McpServer {
  const { chain, deploy } = deps;
  const server = new McpServer({ name: "extents", version: "0.1.0" });

  for (const [name, tool] of Object.entries(SERVER_TOOLS)) {
    if (name === "update_draft") continue; // the customer agent's canvas, not a protocol operation
    // each tool's own Zod schema, so MCP validates input exactly as the agent loop does
    const inputSchema = tool.input as z.ZodObject;
    server.registerTool(
      name,
      { description: tool.description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } },
      async (input) => json(await abortable(deps.signal, () => tool.run(input as never, chain, deps.signal))),
    );
  }

  server.registerTool(
    "draft_objective",
    {
      description: `Turn agreed terms into an objective: its exact Params, its NEP-616 address and the unsigned transactions that launch it. Nothing is sent. The sponsor then (1) deploys it with deploy_objective, (2) signs the FastData call that publishes the terms, and (3) signs the funding call (${TOKEN.symbol} on the NEAR Intents Verifier). Pass back a salt from an earlier draft to get the same objective again.`,
      inputSchema: {
        proposal,
        sponsor: accountId,
        salt: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ proposal: p, sponsor, salt }) => {
      const o = buildObjective(p, sponsor, salt ?? randomSalt(), objectiveCodeHash());
      return json({
        objective: o.accountId,
        params: o.params,
        spec: o.spec,
        transactions: [
          {
            step: "publish",
            signer: sponsor,
            ...describe(calls.publish(o.accountId, { params: o.params, spec: o.spec })),
            note: PUBLISH_NOTE,
          },
          { step: "fund", signer: sponsor, ...describe(calls.fund(o.accountId, o.params, o.amount)) },
        ],
      });
    },
  );

  server.registerTool(
    "deploy_objective",
    {
      description:
        "Deploy a drafted objective's contract at its derived address. Permissionless and idempotent: the address is derived from Params, so this cannot change what is deployed, and an existing objective is left as it is.",
      inputSchema: { params: z.record(z.string(), z.unknown()) },
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    async ({ params }) => spending(deps) ?? json(await deploy(params as unknown as Params)),
  );

  server.registerTool(
    "evaluate_objective",
    {
      description: `Judge an objective's delivered reports against its published terms, as its evaluator would: every criterion's result, and, when the results support a verdict (achieved needs every criterion to pass, failed needs one to fail), the review document plus the unsigned calls that publish it and attest its hash. llm_judge criteria run on NEAR AI Cloud and carry its signed receipt. Nothing is sent: the evaluator signs ob_attest, or a member files the add_proposal when the evaluator is a Sputnik DAO.`,
      inputSchema: { objective: accountId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ objective }) => {
      const refused = spending(deps);
      if (refused) return refused;
      const result = await evaluate(objective, deps);
      if (!("review" in result) || !result.review) return json(result);
      const { params, evaluator_dao } = result as { params: Params; evaluator_dao?: Dao };
      const publish = {
        step: "publish",
        ...describe(calls.publish(objective, { review: result.review })),
        note: `Anyone may sign it. ${PUBLISH_NOTE}`,
      };
      const attest = evaluator_dao
        ? {
            step: "propose",
            signer: "a member allowed to add proposals",
            ...describe(calls.propose(objective, params, attestationOf(result.review), evaluator_dao.proposal_bond)),
            note: "Settles the escrow once the DAO approves it, before the deadline.",
          }
        : { step: "attest", signer: params.evaluator, ...describe(calls.attest(objective, params, attestationOf(result.review))) };
      return json({ ...result, transactions: [publish, attest] });
    },
  );

  return server;
}

/** One stateless MCP request: a fresh server per request, answers as JSON. */
export async function mcpResponse(req: Request, deps: McpDeps): Promise<Response> {
  const server = createServer({ ...deps, signal: withTimeout(req.signal, RUN_MS) });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
