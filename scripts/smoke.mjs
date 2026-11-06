// End-to-end smoke test: spawns the built server over stdio with the official MCP client
// and calls every read-only tool against the live Hertwill API.
// Authenticated tools run only when HERTWILL_API_KEY is set. Nothing is modified in your store.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const env = { ...process.env };
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "inherit" });
// PROTOCOL=legacy for 2025-era initialize; default pins the 2026-07-28 revision.
const modern = process.env.PROTOCOL !== "legacy";
const client = new Client(
  { name: "hertwill-smoke", version: "0.0.0" },
  modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
);
await client.connect(transport);

let failures = 0;
const call = async (name, args = {}, { expectError = false } = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  const good = expectError ? res.isError : !res.isError;
  if (!good) failures++;
  console.log(`${good ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args)} -> ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  return text;
};

console.log("protocol:", client.getNegotiatedProtocolVersion(), "era:", client.getProtocolEra(), "server:", JSON.stringify(client.getServerVersion()));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

const list = JSON.parse(await call("search_products", { per_page: 2 }));
await call("search_products", { query: "alpaca", ships_to: "FI", per_page: 2 });
const first = list.data[0];
await call("get_product", { id_or_slug: String(first.id), lang: "DE" });
await call("get_product", { id_or_slug: first.slug });
await call("get_product", { id_or_slug: "999999999" }, { expectError: true });
await call("list_categories");
await call("get_category", { id_or_slug: "apparel-accessories" });
const brands = JSON.parse(await call("list_brands"));
await call("get_brand", { brand_id: Number(brands[0].id) });
await call("get_brand_shipping_prices", { brand_id: Number(brands[0].id), destination: "FI" });

if (process.env.HERTWILL_API_KEY) {
  const il = JSON.parse(await call("list_import_list", { status: "approved", per_page: 2 }));
  await call("list_sync_jobs", { per_page: 2 });
  await call("get_sync_health");
  if (il.data?.[0]) {
    await call("get_sync_status", { product_id: il.data[0].id });
    // Idempotent: product is already in the import list, so this is a no-op returning "already_exists".
    await call("add_to_import_list", { product_ids: [il.data[0].id] });
  }
  // Validation path of sync_product: an unknown variation id is rejected before any sync is started.
  if (il.data?.[0]) await call("sync_product", { product_id: il.data[0].id, selling_price: 999, variation_prices: { "1": 1 } }, { expectError: true });
} else {
  console.log("HERTWILL_API_KEY not set: skipping authenticated tools");
  await call("get_sync_health", {}, { expectError: true });
}

await client.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
