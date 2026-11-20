import { defineConfig, loadEnv } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

// PUBLIC_* from the workspace's .env, one level up, as well as the process env
const { publicVars } = loadEnv({ cwd: "..", prefixes: ["PUBLIC_"] });

/**
 * Every PUBLIC_* variable the browser code reads, defined even when unset: an
 * undefined one would be left as `process.env.X`, which throws in a browser.
 * Set values win, since `publicVars` comes last.
 */
const browserEnv = {
  "process.env.PUBLIC_E2E": '""',
  "process.env.PUBLIC_OBJECTIVE_CODE_HASH": '""',
  ...publicVars,
};

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: "./src/web/main.tsx" }, define: browserEnv },
  html: {
    title: "Extents",
    template: "./src/web/index.html",
    mountId: "root",
    meta: { description: "Fund an outcome. The money is released only when it happens." },
    tags: [
      { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
      { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" } },
      {
        tag: "link",
        attrs: {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono&display=swap",
        },
      },
    ],
  },
  output: { distPath: { root: process.env.DIST_DIR ?? "dist" } },
  server: {
    port: 3001,
    proxy: { "/api": `http://localhost:${process.env.PORT ?? 3000}`, "/mcp": `http://localhost:${process.env.PORT ?? 3000}` },
  },
});
