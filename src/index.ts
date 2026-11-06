#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HertwillClient } from "./client.js";
import { registerTools } from "./tools.js";

const { version, description } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  description: string;
};

// Inlined as a data: URI so it works over stdio, where the client cannot fetch a relative path.
const icon = {
  src: `data:image/svg+xml;base64,${readFileSync(new URL("../assets/icon.svg", import.meta.url)).toString("base64")}`,
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

const HOUR = 3_600_000;

const client = new HertwillClient({
  apiKey: process.env.HERTWILL_API_KEY,
  baseUrl: process.env.HERTWILL_API_URL,
  userAgent: `hertwill-mcp/${version}`,
});

const handle = serveStdio(
  () => {
    const server = new McpServer(
      {
        name: "hertwill",
        title: "Hertwill",
        version,
        description,
        websiteUrl: "https://github.com/aanndryyyy/hertwill-mcp",
        icons: [icon],
      },
      {
        capabilities: { tools: {} },
        // 2026-07-28 cacheable results. The tool list never changes while the process runs, but its descriptions
        // depend on whether this user's API key is set, so it must not be shared between users: scope 'private'.
        cacheHints: {
          "tools/list": { ttlMs: HOUR, cacheScope: "private" },
          "server/discover": { ttlMs: HOUR, cacheScope: "public" },
        },
        instructions:
          "Tools for the Hertwill dropshipping platform. Typical flow: search_products → get_product → " +
          "add_to_import_list → sync_product (with an ABSOLUTE selling price) → get_sync_status. " +
          "Prices are wholesale EUR. Import-list and sync tools need HERTWILL_API_KEY.",
      },
    );
    registerTools(server, client);
    return server;
  },
  { onerror: (err) => console.error("[hertwill-mcp]", err) },
);

if (!client.hasApiKey) {
  console.error("[hertwill-mcp] HERTWILL_API_KEY not set: only public catalog tools will work, and prices are hidden.");
}

const shutdown = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
