import { defineConfig } from "@playwright/test";

const APP = Number(process.env.E2E_APP_PORT ?? 3124);
const LLM = Number(process.env.E2E_LLM_PORT ?? 3125);
const CHAIN = Number(process.env.E2E_CHAIN_PORT ?? 3126);

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results",
  fullyParallel: true,
  use: { baseURL: `http://localhost:${APP}`, trace: "retain-on-failure" },
  webServer: [
    { command: "node test/e2e/mock-llm.ts", port: LLM, env: { MOCK_LLM_PORT: String(LLM) } },
    // the server's own chain reads go to an empty stand-in testnet, never the public RPC
    { command: "node test/e2e/mock-chain.ts", port: CHAIN, env: { MOCK_CHAIN_PORT: String(CHAIN) } },
    {
      command: "pnpm exec rsbuild build && bun src/server/index.ts",
      port: APP,
      timeout: 180_000,
      env: {
        PORT: String(APP),
        DIST_DIR: process.env.E2E_DIST_DIR ?? "dist-e2e",
        PUBLIC_E2E: "1",
        PUBLIC_OBJECTIVE_CODE_HASH: "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa",
        PUBLIC_SPONSOR_RELEASE: "1",
        NEARAI_BASE_URL: `http://localhost:${LLM}/v1`,
        NEARAI_API_KEY: "test",
        NEARAI_MODEL: "mock",
        NEAR_RPC_URL: `http://localhost:${CHAIN}`,
        FASTDATA_URL: `http://localhost:${CHAIN}`,
      },
    },
  ],
});
