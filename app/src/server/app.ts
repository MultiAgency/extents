/** The API: the customer agent over AG-UI, live checks and evaluation, the StateInit deploy, objective reads. */
import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Budget } from "./budget.ts";
import { RUN_MS, withTimeout } from "./bounded.ts";

import { validateParams, type Params } from "../shared/params.ts";
import { accountId } from "../shared/spec.ts";
import { runAgent, type AgentDeps } from "./agent.ts";
import type { CheckDeps } from "./checks.ts";
import { mcpResponse } from "./mcp.ts";
import { runChecks, runEvaluation, type CheckRunDeps } from "./precheck.ts";

export interface AppDeps extends AgentDeps {
  deploy(params: Params): Promise<{ accountId: string; txHash?: string }>;
  checks: CheckDeps;
  delivered: CheckRunDeps["delivered"];
}

/** An AG-UI event stream as an SSE response. */
function sse(events: AsyncIterable<BaseEvent>, accept: string | undefined): Response {
  const encoder = new EventEncoder({ accept });
  const iterator = events[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(new TextEncoder().encode(encoder.encodeSSE(value)));
    },
    async cancel() {
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

  const signalFor = (signal: AbortSignal) => withTimeout(signal, RUN_MS);

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

    return sse(runAgent(input, account.data, deps, signalFor(c.req.raw.signal)), c.req.header("accept"));
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
      return sse(runner(parsed.data, { ...deps, signal: signalFor(c.req.raw.signal) }), c.req.header("accept"));
    });
  }

  /** Permissionless and trustless: the address is derived from Params, so the deployer cannot change what is deployed. */
  app.post("/api/deploy", async (c) => {
    try {
      const { params } = (await c.req.json()) as { params: Params };
      const problem = validateParams(params);
      if (problem) return c.json({ error: problem }, 400);
      const spent = charge();
      if (spent) return c.json({ error: spent }, 429);
      return c.json(await deps.deploy(params));
    } catch (e) {
      return c.json(failure(e), 400);
    }
  });

  /** Extents for other agents: see /llms.txt. */
  app.all("/mcp", (c) => mcpResponse(c.req.raw, { ...deps, charge }));

  app.get("/api/objective/:id", async (c) => {
    try {
      return c.json(await deps.chain.describeObjective(c.req.param("id")));
    } catch (e) {
      console.error(e);
      return c.json({ error: "could not read the objective" }, 502);
    }
  });

  return app;
}
