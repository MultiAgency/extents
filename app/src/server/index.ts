/** One Bun process: the built web app at `/`, the API at `/api/*`. */
import { join } from "node:path";

import { createApp } from "./app.ts";
import * as chain from "./chain.ts";
import { nearAiModel } from "./model.ts";
import { readDeliverables } from "./fastdata.ts";
import { evidenceFetch } from "./evidence-fetch.ts";
import { nearAiJudge } from "./judge.ts";
import { Budget } from "./budget.ts";
import { evidenceArchive } from "./archive.ts";

const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) throw new Error("NEARAI_API_KEY is not set");

const archive = evidenceArchive(process.env.EVIDENCE_ARCHIVE_DIR ?? join(import.meta.dir, "../../var/evidence"));
const nearAi = {
  apiKey,
  model: process.env.NEARAI_MODEL || undefined,
  baseUrl: process.env.NEARAI_BASE_URL || undefined,
  signingKeys: process.env.NEARAI_SIGNING_KEYS?.split(",")
    .map((key) => key.trim())
    .filter(Boolean),
};
const model = nearAiModel(nearAi);
const deployments = new Budget(10, 1);
const app = createApp({
  model,
  chain,
  deploy: async (params, spec) => {
    const release = deployments.acquire();
    try {
      return await chain.deployObjective(params, spec);
    } finally {
      release();
    }
  },
  checks: {
    fetch: evidenceFetch as typeof fetch,
    archive,
    judge: nearAiJudge(nearAi),
  },
  delivered: readDeliverables,
});

const dist = join(import.meta.dir, "../..", process.env.DIST_DIR ?? "dist");
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  idleTimeout: 255, // a run waits on the model between events
  maxRequestBodySize: 256 * 1024,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) return app.fetch(req);
    const path = join(dist, pathname === "/" ? "index.html" : pathname);
    const file = Bun.file(path);
    // the SPA's own routes fall back to index.html; nothing outside dist is served
    return path.startsWith(dist) && (await file.exists()) ? new Response(file) : new Response(Bun.file(join(dist, "index.html")));
  },
});
console.log(`extents on http://localhost:${port}`);
