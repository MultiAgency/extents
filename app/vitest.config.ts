import { defineConfig } from "vitest/config";

// browser tests run under Playwright
export default defineConfig({ test: { exclude: ["node_modules/**", "test/e2e/**", "test/capture/**"] } });
