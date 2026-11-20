import { defineConfig } from "@playwright/test";

const APP = Number(process.env.E2E_APP_PORT ?? 3124);
const LLM = Number(process.env.E2E_LLM_PORT ?? 3125);

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results",
  fullyParallel: true,
  use: { baseURL: `http://localhost:${APP}`, trace: "retain-on-failure" },
  webServer: [
    { command: "node test/e2e/mock-llm.ts", port: LLM, env: { MOCK_LLM_PORT: String(LLM) } },
    {
      command: "pnpm exec rsbuild build && bun src/server/index.ts",
      port: APP,
      timeout: 180_000,
      env: {
        PORT: String(APP),
        DIST_DIR: process.env.E2E_DIST_DIR ?? "dist-e2e",
        PUBLIC_E2E: "1",
        PUBLIC_OBJECTIVE_CODE_HASH: "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa",
        NEARAI_BASE_URL: `http://localhost:${LLM}/v1`,
        NEARAI_API_KEY: "test",
        NEARAI_MODEL: "mock",
      },
    },
  ],
});
