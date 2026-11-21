/**
 * The API: the customer agent over AG-UI, live checks and evaluation, the
 * StateInit deploy, objective reads, and the same work as plain JSON for
 * other agents (documented for them in /llms.txt and /skill.md).
 */
import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Budget } from "./budget.ts";
import { abortable, RUN_MS, withTimeout } from "./bounded.ts";
import { RPC_READ_MS } from "./rpc.ts";

import { z } from "zod";

import { proposal } from "../shared/objective.ts";
import { validateParams, type Params } from "../shared/params.ts";
import { accountId, parseSpec, specHash, type Spec } from "../shared/spec.ts";
import { runAgent, type AgentDeps } from "./agent.ts";
import { contribute, draft, review, type ContributorView } from "./agents.ts";
import type { CheckDeps } from "./checks.ts";
import type { ObjectiveUsage } from "./archive.ts";
import { runChecks, runEvaluation, type CheckRunDeps } from "./precheck.ts";
import { SERVER_TOOLS } from "./tools.ts";

export interface AppDeps extends AgentDeps {
  /** With `spec`, also publishes the terms from the deployer, for a sponsor with no NEAR key. */
  deploy(params: Params, spec?: Spec): Promise<{ accountId: string; txHash?: string; published?: boolean }>;
  checks: CheckDeps;
  delivered: CheckRunDeps["delivered"];
  /** The most one objective may add to the evidence archive; defaults to the archive module's ceiling. */
  archiveObjectiveBytes?: number;
}

/** An AG-UI event stream as an SSE response. */
function sse(run: (signal: AbortSignal) => AsyncIterable<BaseEvent>, requestSignal: AbortSignal, accept: string | undefined): Response {
  const encoder = new EventEncoder({ accept });
  const cancelled = new AbortController();
  const signal = withTimeout(AbortSignal.any([requestSignal, cancelled.signal]), RUN_MS);
  const iterator = run(signal)[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        cancelled.abort();
        controller.close();
      } else controller.enqueue(new TextEncoder().encode(encoder.encodeSSE(value)));
    },
    async cancel() {
      cancelled.abort();
      await iterator.return?.();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

const failure = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // every request holds a slot until its response is consumed; only costly work (a model run, checks, a deploy) spends the hourly allowance
  const slots = new Budget(Infinity, 4);
  // the evaluator's memory for the retry rule; per process, so a restart only restarts the retry window
  const unreachableSince = new Map<string, number>();
  // what each objective has asked the evidence archive to keep, so one objective cannot fill it for every other
  const archiveUsage: ObjectiveUsage = new Map();
  const hourly = new Budget(200, Infinity);
  /** Spends one costly operation, or says why not. */
  const charge = (): string | undefined => {
    try {
      hourly.acquire()();
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  };

  app.use("*", bodyLimit({ maxSize: 256 * 1024 }));
  app.use("*", async (c, next) => {
    let release: () => void;
    try {
      release = slots.acquire();
    } catch (e) {
      return c.json({ error: (e as Error).message }, 429);
    }
    try {
      await next();
      const response = c.res;
      if (!response.body) {
        release();
        return;
      }
      const reader = response.body.getReader();
      const finish = () => {
        release();
        reader.releaseLock();
      };
      c.res = new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const { value, done } = await reader.read();
              if (done) {
                finish();
                controller.close();
              } else controller.enqueue(value);
            } catch (e) {
              finish();
              controller.error(e);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              finish();
            }
          },
        }),
        { status: response.status, headers: response.headers },
      );
    } catch (e) {
      release();
      throw e;
    }
  });

  /** One AG-UI run. The customer's account rides in `forwardedProps`; launch_objective must be advertised. */
  app.post("/api/agent", async (c) => {
    const parsed = RunAgentInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid run input" }, 400);
    const input = parsed.data;
    const account = accountId.safeParse((input.forwardedProps as { account?: unknown } | undefined)?.account);
    if (!account.success) return c.json({ error: "connect a wallet first" }, 400);
    if (!(input.tools ?? []).some((t) => t.name === "launch_objective"))
      return c.json({ error: "the page must advertise launch_objective" }, 400);
    const spent = charge();
    if (spent) return c.json({ error: spent }, 429);

    return sse((signal) => runAgent(input, account.data, deps, signal), c.req.raw.signal, c.req.header("accept"));
  });

  // a deliverable checked against the published terms (`forwardedProps = {objective, deliverable}`), and the
  // evaluator's run over what was delivered, ending with the review to attest (`forwardedProps = {objective}`)
  for (const [path, runner] of [
    ["/api/check", runChecks],
    ["/api/evaluate", runEvaluation],
  ] as const) {
    app.post(path, async (c) => {
      const parsed = RunAgentInputSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "invalid run input" }, 400);
      const spent = charge();
      if (spent) return c.json({ error: spent }, 429);
      return sse((signal) => runner(parsed.data, { ...deps, unreachableSince, archiveUsage, signal }), c.req.raw.signal, c.req.header("accept"));
    });
  }

  /**
   * Permissionless and trustless: the address is derived from Params, so the
   * deployer cannot change what is deployed. With the spec, it publishes the
   * terms too, and the spec hash in Params pins what it can publish.
   */
  app.post("/api/deploy", async (c) => {
    try {
      const { params, spec: raw } = (await c.req.json()) as { params: Params; spec?: unknown };
      const problem = validateParams(params);
      if (problem) return c.json({ error: problem }, 400);
      const spec = raw === undefined ? undefined : parseSpec(raw);
      if (spec && specHash(spec) !== params.spec_hash) return c.json({ error: "the spec does not match params.spec_hash" }, 400);
      const spent = charge();
      if (spent) return c.json({ error: spent }, 429);
      return c.json(await deps.deploy(params, spec));
    } catch (e) {
      return c.json(failure(e), 400);
    }
  });

  /** The customer agent's tools, for any agent: the body is the tool's input, checked by the same schema. */
  app.post("/api/tools/:name", async (c) => {
    const name = c.req.param("name");
    const tool = name === "update_draft" ? undefined : SERVER_TOOLS[name]; // the customer's canvas, not a protocol operation
    if (!tool) return c.json({ error: `no tool ${name}; see /llms.txt` }, 404);
    const input = tool.input.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return c.json({ error: `invalid input: ${z.prettifyError(input.error)}` }, 400);
    try {
      const signal = withTimeout(c.req.raw.signal, RPC_READ_MS);
      return c.json(await abortable(signal, () => tool.run(input.data as never, deps.chain, signal)));
    } catch (e) {
      console.error(e);
      return c.json({ error: `${name} failed; try again` }, 502);
    }
  });

  const draftInput = z.object({
    proposal,
    sponsor: accountId,
    salt: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  });
  /** Agreed terms as an objective, down to the sponsor's unsigned transactions. Nothing is sent. */
  app.post("/api/draft", async (c) => {
    const input = draftInput.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return c.json({ error: `invalid input: ${z.prettifyError(input.error)}` }, 400);
    try {
      return c.json(draft(input.data.proposal, input.data.sponsor, input.data.salt, c.req.url));
    } catch (e) {
      return c.json(failure(e), 400);
    }
  });

  const contributeInput = z.object({
    account: accountId,
    // the reader accepts no longer report
    report: z.string().min(1).max(200_000).optional(),
    delivery_tx: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/)
      .optional(),
    delivery_signer: accountId.optional(),
  });
  /** A contributor's part as unsigned calls, one step at a time: commit, deliver the report's hash, publish the report. Nothing is sent. */
  app.post("/api/objective/:id/contribute", async (c) => {
    const objective = accountId.safeParse(c.req.param("id"));
    if (!objective.success) return c.json({ error: "not an account id" }, 400);
    const input = contributeInput.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return c.json({ error: `invalid input: ${z.prettifyError(input.error)}` }, 400);
    let view: ContributorView;
    try {
      const signal = withTimeout(c.req.raw.signal, RPC_READ_MS);
      view = (await abortable(signal, () => deps.chain.describeObjective(objective.data, signal))) as ContributorView;
    } catch (e) {
      console.error(e);
      return c.json({ error: "could not read the objective" }, 502);
    }
    try {
      return c.json(contribute(objective.data, view, input.data, c.req.url));
    } catch (e) {
      return c.json(failure(e), 400);
    }
  });

  /** The evaluation as one JSON answer: the review and the evaluator's unsigned calls, when the results support a verdict. */
  app.post("/api/objective/:id/review", async (c) => {
    const objective = accountId.safeParse(c.req.param("id"));
    if (!objective.success) return c.json({ error: "not an account id" }, 400);
    const spent = charge();
    if (spent) return c.json({ error: spent }, 429);
    const signal = withTimeout(c.req.raw.signal, RUN_MS);
    return c.json(await review(objective.data, { ...deps, unreachableSince, archiveUsage, signal }, c.req.url));
  });

  app.get("/api/objective/:id", async (c) => {
    try {
      const signal = withTimeout(c.req.raw.signal, RPC_READ_MS);
      return c.json(await abortable(signal, () => deps.chain.describeObjective(c.req.param("id"), signal)));
    } catch (e) {
      console.error(e);
      return c.json({ error: "could not read the objective" }, 502);
    }
  });

  return app;
}
