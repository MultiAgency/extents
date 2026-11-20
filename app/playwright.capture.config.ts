/** Opt-in design artifacts; excluded from the regression suite. */
import { defineConfig } from "@playwright/test";
import regression from "./playwright.config.ts";

export default defineConfig({ ...regression, testDir: "test/capture" });
