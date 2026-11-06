import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { HertwillApiError, HertwillClient, type Query } from "./client.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const fail = (err: unknown): ToolResult => {
  if (err instanceof HertwillApiError) {
    const payload: Record<string, unknown> = { error: { status: err.status, code: err.code, message: err.message } };
    if (err.details !== undefined) (payload.error as any).details = err.details;
    if (err.requestId) (payload.error as any).request_id = err.requestId;
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${(err as Error)?.message ?? String(err)}` }], isError: true };
};

/** Wrap a handler so API errors come back as tool errors the model can read and act on. */
const run =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

/** Remove fields from every object in `data` (an array) to keep list responses compact. */
const omitFields = (data: unknown, fields: string[]) =>
  Array.isArray(data)
    ? data.map((item) => {
        if (!item || typeof item !== "object") return item;
        const copy: Record<string, unknown> = { ...item };
        for (const f of fields) delete copy[f];
        return copy;
      })
    : data;

/** Keep only the first image in list responses. */
const slimImages = (data: unknown) =>
  Array.isArray(data)
    ? data.map((item: any) =>
        item?.images && typeof item.images === "object"
          ? { ...item, images: { featured: item.images.featured ?? null, gallery_count: item.images.gallery?.length ?? 0 } }
          : item,
      )
    : data;

const LANGS = [
  "EN", "BG", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR",
  "HU", "IT", "LT", "LV", "NL", "PL", "PT", "RO", "SE", "SK",
] as const;

const page = z.number().int().min(1).optional().describe("Page number (default 1).");
const perPage = z.number().int().min(1).max(100).optional().describe("Results per page, 1–100 (default 50).");

const productFilters = {
  brand: z.string().optional().describe("Brand slug (see list_brands)."),
  category: z.string().optional().describe("Category slug (see list_categories)."),
  min_price: z.number().optional().describe("Minimum wholesale price in EUR."),
  max_price: z.number().optional().describe("Maximum wholesale price in EUR."),
  on_sale: z.boolean().optional().describe("Only products currently on sale."),
  stock_status: z.enum(["instock", "outofstock"]).optional(),
  shipping_region: z.string().optional().describe("Filter by shipping region."),
  ships_to: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe("ISO 3166-1 alpha-2 country code; only products sellable to this country (e.g. 'DE')."),
  attributes: z.string().optional().describe("Comma-separated attribute values to filter by."),
  sort_by: z.enum(["price", "date", "sales"]).optional(),
  sort_order: z.enum(["asc", "desc"]).optional().describe("Default 'desc'."),
  page,
  per_page: perPage,
};

export function registerTools(server: McpServer, client: HertwillClient): void {
  const priceNote = client.hasApiKey
    ? ""
    : " Note: wholesale `price` is null unless HERTWILL_API_KEY is configured.";

  // ───────────────────────────── Catalog (public) ─────────────────────────────

  server.registerTool(
    "search_products",
    {
      title: "Search / browse products",
      description:
        "Search or browse the Hertwill dropshipping catalog with filters, sorting and pagination. " +
        "Pass `query` for full-text search; omit it to browse. Returns compact product summaries (no HTML description, " +
        "no variations) — call get_product for full details and variation ids." +
        priceNote,
      inputSchema: z.object({
        query: z.string().min(1).optional().describe("Full-text search query. Omit to browse all products."),
        ...productFilters,
        include_description: z.boolean().optional().describe("Include the HTML description (default false, to save tokens)."),
        include_facets: z
          .boolean()
          .optional()
          .describe("Include facet counts (brands, categories, attributes…) for refining filters (default false; large)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ query, include_description, include_facets, ...filters }) => {
      const res: any = await client.request("GET", query ? "/v1/products/search" : "/v1/products", {
        query: { ...(filters as Query), q: query },
      });
      let data = res.data;
      if (!include_description) data = omitFields(data, ["description"]);
      data = slimImages(data);
      const meta = { ...(res.meta ?? {}) };
      if (!include_facets) delete meta.facets;
      delete meta.request_id;
      return { data, meta };
    }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product details",
      description:
        "Get full details for one catalog product by numeric id or slug, including variations (with their catalog " +
        "variation ids), images, attributes, shipping, packaging and compliance data." +
        priceNote,
      inputSchema: z.object({
        id_or_slug: z.string().min(1).describe("Numeric product id (e.g. '11180') or product slug."),
        lang: z
          .enum(LANGS)
          .optional()
          .describe("Return the description in this language. Names are not translated."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ id_or_slug, lang }) => {
      const path = /^\d+$/.test(id_or_slug)
        ? `/v1/products/${id_or_slug}`
        : `/v1/products/slug/${encodeURIComponent(id_or_slug)}`;
      return client.request("GET", path, { query: { lang } });
    }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description: "List the product category tree (id, slug, name, children). Use slugs as the `category` filter.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => (await client.request<any>("GET", "/v1/categories")).data),
  );

  server.registerTool(
    "get_category",
    {
      title: "Get category",
      description: "Get one category by id or slug.",
      inputSchema: z.object({ id_or_slug: z.string().min(1) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ id_or_slug }) => (await client.request<any>("GET", `/v1/categories/${encodeURIComponent(id_or_slug)}`)).data),
  );

  server.registerTool(
    "list_brands",
    {
      title: "List brands",
      description:
        "List all brands (id, name, slug, dispatch days, shipping origin…). Long descriptions are omitted unless " +
        "`include_description` is true. Use slugs as the `brand` filter in search_products.",
      inputSchema: z.object({
        include_description: z.boolean().optional().describe("Include brand descriptions (default false)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ include_description }) => {
      const data = (await client.request<any>("GET", "/v1/brands")).data;
      return include_description ? data : omitFields(data, ["description", "return_policy", "responsible_person", "gpsr"]);
    }),
  );

  server.registerTool(
    "get_brand",
    {
      title: "Get brand",
      description: "Get full details for one brand by numeric id, including return policy, GPSR and responsible person.",
      inputSchema: z.object({ brand_id: z.number().int().describe("Numeric brand id.") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ brand_id }) => (await client.request<any>("GET", `/v1/brands/${brand_id}`)).data),
  );

  server.registerTool(
    "get_brand_shipping_prices",
    {
      title: "Get brand shipping prices",
      description:
        "Get a brand's shipping price lists: per destination country price and delivery days. " +
        "Optionally filter to one destination country.",
      inputSchema: z.object({
        brand_id: z.number().int().describe("Numeric brand id."),
        destination: z
          .string()
          .regex(/^[A-Za-z]{2}$/)
          .optional()
          .describe("ISO 3166-1 alpha-2 destination country to filter to (e.g. 'FI')."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ brand_id, destination }) => {
      const lists = (await client.request<any>("GET", `/v1/brands/${brand_id}/shipping-price-lists`)).data;
      if (!destination || !Array.isArray(lists)) return lists;
      const dest = destination.toUpperCase();
      return lists.map((l: any) => ({
        ...l,
        shipping_prices: (l.shipping_prices ?? []).filter((p: any) => p.dest_iso_code === dest),
      }));
    }),
  );

  // ─────────────────────────── Import list (API key) ──────────────────────────

  server.registerTool(
    "list_import_list",
    {
      title: "List import list",
      description:
        "List products in your store's import list. Defaults to status 'not-synced' (products not yet in your store); " +
        "pass status 'synced' for already-synced ones. Each item's `id` is the catalog product id to use with " +
        "sync_product; `variations` holds the (id, dropship_id) pairs. Requires HERTWILL_API_KEY.",
      inputSchema: z.object({
        status: z
          .enum(["not-synced", "syncing", "synced", "sync-failed", "approved", "rejected", "pending", "approval-required"])
          .optional()
          .describe("Status slice to list (default 'not-synced')."),
        order_by: z.enum(["added_dt", "name", "price"]).optional().describe("Default 'added_dt'."),
        order: z.enum(["asc", "desc"]).optional().describe("Default 'desc'."),
        include_description: z.boolean().optional().describe("Include HTML descriptions (default false)."),
        page,
        per_page: perPage,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ include_description, ...q }) => {
      const res: any = await client.request("GET", "/v1/import-list", { query: q as Query, requireKey: true });
      let data = res.data;
      if (!include_description) data = omitFields(data, ["description"]);
      data = slimImages(data);
      return { data, pagination: res.meta?.pagination };
    }),
  );

  server.registerTool(
    "add_to_import_list",
    {
      title: "Add products to import list",
      description:
        "Add 1–50 catalog products to your store's import list. Idempotent: re-adding returns status 'already_exists'. " +
        "The response includes each product's `variations` (id, dropship_id) pairs. Requires HERTWILL_API_KEY.",
      inputSchema: z.object({
        product_ids: z.array(z.number().int()).min(1).max(50).describe("Catalog product ids to add."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ product_ids }) =>
      (await client.request<any>("POST", "/v1/import-list/products", { body: { product_ids }, requireKey: true })).data,
    ),
  );

  server.registerTool(
    "remove_from_import_list",
    {
      title: "Remove product from import list",
      description: "Remove a product from your store's import list. Requires HERTWILL_API_KEY.",
      inputSchema: z.object({
        product_id: z.number().int().describe("Catalog product id (the import-list item's `id`)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ product_id }) => {
      const res = await client.request<any>("DELETE", `/v1/import-list/products/${product_id}`, { requireKey: true });
      return res?.data ?? { product_id, removed: true };
    }),
  );

  // ───────────────────────────── Sync (API key) ───────────────────────────────

  server.registerTool(
    "sync_product",
    {
      title: "Sync product to store",
      description:
        "Publish a product from your import list to your connected Shopify/WooCommerce store at the selling price you choose. " +
        "`selling_price` is the ABSOLUTE retail price in your store currency (e.g. 24.99) — NOT a markup multiplier or " +
        "percentage; it must be at or above the wholesale price. For products with variants, the variation (id, dropship_id) " +
        "pairs are resolved automatically (the product is added to the import list first if needed); every variant gets " +
        "`selling_price` unless overridden in `variation_prices`. Runs asynchronously — check progress with get_sync_status. " +
        "Requires HERTWILL_API_KEY.",
      inputSchema: z.object({
        product_id: z
          .number()
          .int()
          .describe("Catalog product id — the import-list item's `id` (NOT its `product_id` record id)."),
        selling_price: z
          .number()
          .positive()
          .describe("ABSOLUTE selling price in your store currency (e.g. 24.99). Not a multiplier like 1.5."),
        variation_prices: z
          .record(z.string().regex(/^\d+$/), z.number().positive())
          .optional()
          .describe("Optional per-variant absolute prices, keyed by catalog variation id, e.g. {\"20972\": 29.99}."),
        currency: z.string().optional().describe("Store currency code, e.g. 'EUR'. Defaults to the store's currency."),
        lang: z.string().optional().describe("Language to publish the description in, e.g. 'EN'."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ product_id, selling_price, variation_prices, currency, lang }) => {
      // Idempotent add: guarantees the product is in the import list and returns the full (id, dropship_id) pairing.
      const added = await client.request<any>("POST", "/v1/import-list/products", {
        body: { product_ids: [product_id] },
        requireKey: true,
      });
      const entry = (added.data ?? []).find((d: any) => d.product_id === product_id) ?? added.data?.[0];
      if (!entry || entry.status === "not_found" || entry.status === "error") {
        throw new HertwillApiError(
          404,
          "PRODUCT_NOT_FOUND",
          `Product ${product_id} could not be added to the import list (status: ${entry?.status ?? "unknown"}). ` +
            "Check the id with get_product.",
        );
      }
      const pairs: { id: number; dropship_id: number }[] = entry.variations ?? [];
      const known = new Set(pairs.map((p) => String(p.id)));
      const unknown = Object.keys(variation_prices ?? {}).filter((k) => !known.has(k));
      if (unknown.length) {
        throw new HertwillApiError(
          422,
          "UNKNOWN_VARIATION",
          `variation_prices has ids that are not variations of product ${product_id}: ${unknown.join(", ")}. ` +
            `Valid variation ids: ${[...known].join(", ") || "(none — this product has no variants)"}.`,
        );
      }

      const body: Record<string, unknown> = { product_id, default_store_markup: selling_price, currency, lang };
      if (pairs.length) {
        body.variations = pairs.map((p) => ({
          id: p.id,
          dropship_id: p.dropship_id,
          default_store_markup: variation_prices?.[String(p.id)] ?? selling_price,
        }));
      }
      const res = await client.request<any>("POST", "/v1/sync/products", { body, requireKey: true });
      return { ...(res.data ?? res), variations_submitted: pairs.length };
    }),
  );

  server.registerTool(
    "get_sync_health",
    {
      title: "Store sync health",
      description:
        "Get your store's sync health (healthy / degraded / disabled), per-status counts and the failing products with " +
        "their error class. Requires HERTWILL_API_KEY.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => (await client.request<any>("GET", "/v1/sync/health", { requireKey: true })).data),
  );

  server.registerTool(
    "list_sync_jobs",
    {
      title: "List sync jobs",
      description: "List products by sync status (omit status for all). Requires HERTWILL_API_KEY.",
      inputSchema: z.object({
        status: z.enum(["syncing", "synced", "sync-failed", "not-synced"]).optional(),
        page,
        per_page: perPage,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (q) => {
      const res: any = await client.request("GET", "/v1/sync/jobs", { query: q as Query, requireKey: true });
      return { data: res.data, pagination: res.meta?.pagination };
    }),
  );

  server.registerTool(
    "get_sync_status",
    {
      title: "Get product sync status",
      description: "Get the sync status of one product in your store. Requires HERTWILL_API_KEY.",
      inputSchema: z.object({ product_id: z.number().int().describe("Catalog product id.") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ product_id }) =>
      (await client.request<any>("GET", `/v1/sync/jobs/${product_id}`, { requireKey: true })).data,
    ),
  );
}
