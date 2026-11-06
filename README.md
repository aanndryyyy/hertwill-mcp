<img src="assets/icon.svg" width="64" height="64" alt="">

# hertwill-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Hertwill](https://hertwill.com) dropshipping API ([API docs](https://hertwill.com/docs)).
Use it to search the catalog, manage your store's import list, and publish products to your Shopify or WooCommerce store, all from Claude or any other MCP client.

- Built on the **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`). It serves the **2026-07-28** protocol revision and still works with clients on the 2025 revisions.
- Uses the stdio transport. It needs Node.js 20 or newer.

## Tools

| Tool | What it does | API key |
| --- | --- | --- |
| `search_products` | Full-text search, or browse with filters (brand, category, price, stock, on sale, ships-to country, attributes) plus sorting and pagination | optional¹ |
| `get_product` | Full product details by id or slug, including variations; optionally translated (21 languages) | optional¹ |
| `list_categories` / `get_category` | The category tree, or a single category | – |
| `list_brands` / `get_brand` | Brand listing, or full details for one brand (return policy, GPSR, …) | – |
| `get_brand_shipping_prices` | A brand's shipping price lists, optionally filtered to one destination country | – |
| `list_import_list` | Your store's import list, filterable by status | required |
| `add_to_import_list` | Add 1–50 products to the import list (idempotent) | required |
| `remove_from_import_list` | Remove a product from the import list | required |
| `sync_product` | Publish a product to your store at an **absolute** selling price. Variant pairs are resolved automatically | required |
| `get_sync_health` | Your store's sync health, counts, and failing products | required |
| `list_sync_jobs` / `get_sync_status` | Sync status for all products, or for one | required |

¹ Catalog tools work without a key, but wholesale `price` comes back `null` unless a key is set.

The API's account endpoints (`/v1/auth/*` and `/v1/api-keys`) are deliberately left out. They need your email and password, and you manage them in the Hertwill dashboard.

## Setup

1. Create a store-scoped API key (`hw_live_…`) in your Hertwill account dashboard.
2. Add the server to your MCP client.

**Claude Code**

```bash
claude mcp add -s user hertwill -e HERTWILL_API_KEY=hw_live_xxx -- npx -y github:aanndryyyy/hertwill-mcp
```

**Claude Desktop, Cursor, and other clients using `mcpServers` JSON**

```json
{
  "mcpServers": {
    "hertwill": {
      "command": "npx",
      "args": ["-y", "github:aanndryyyy/hertwill-mcp"],
      "env": { "HERTWILL_API_KEY": "hw_live_xxx" }
    }
  }
}
```

**From a local clone**

```bash
git clone https://github.com/aanndryyyy/hertwill-mcp.git
cd hertwill-mcp && npm install   # builds dist/ automatically
claude mcp add -s user hertwill -e HERTWILL_API_KEY=hw_live_xxx -- node "$PWD/dist/index.js"
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERTWILL_API_KEY` | – | Store-scoped API key. Required for the import-list and sync tools, and it unlocks prices |
| `HERTWILL_API_URL` | `https://api.hertwill.com` | Override the API base URL |

## Example prompts

- "Find alpaca throws under €150 that ship to Finland."
- "Add products 11167 and 9292 to my import list."
- "Sync product 11167 to my store at €219."
- "Is anything failing to sync in my store?"

## Notes

- **Selling price is absolute.** `sync_product` takes the retail price in your store's currency (e.g. `24.99`), not a markup multiplier. The API rejects prices below wholesale with `PRICE_BELOW_COST`.
- **Variants.** `sync_product` first adds the product to the import list (a no-op if it's already there), so it gets the authoritative `(id, dropship_id)` pairs. Every variant then gets `selling_price`, unless you override individual variants with `variation_prices`.
- **Rate limits.** The API allows 60 requests/min per IP on public endpoints and 300/min per key on authenticated ones. A `429` comes back as a tool error that includes the retry delay.
- **Response size.** List responses leave out HTML descriptions and facets by default. Pass `include_description` / `include_facets` to get them.

## Development

```bash
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js   # interactive testing

# End-to-end smoke test against the live API. It's read-only; authenticated tools run only when a key is set.
HERTWILL_API_KEY=hw_live_xxx npm test                  # 2026-07-28 protocol
PROTOCOL=legacy HERTWILL_API_KEY=hw_live_xxx npm test  # 2025-era protocol
```

## License

MIT
