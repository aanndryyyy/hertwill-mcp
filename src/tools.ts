import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { HertwillApiError, HertwillClient, type Query } from "./client.js";
import * as out from "./schemas.js";

type ToolResult = CallToolResult;

/** Same JSON as text (compact: indentation costs ~30% more tokens) and as `structuredContent` (typed by `outputSchema`). */
const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

const fail = (err: unknown): ToolResult => {
  if (err instanceof HertwillApiError) {
    const payload: Record<string, unknown> = { error: { status: err.status, code: err.code, message: err.message } };
    if (err.details !== undefined) (payload.error as any).details = err.details;
    if (err.requestId) (payload.error as any).request_id = err.requestId;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${(err as Error)?.message ?? String(err)}` }], isError: true };
};

/**
 * Wrap a handler so API errors come back as tool errors the model can read and act on.
 * A handler may also return an `input_required` result (a confirmation request), which is passed through untouched.
 */
const run =
  <A>(fn: (args: A, ctx: ServerContext) => Promise<unknown>) =>
  async (args: A, ctx: ServerContext): Promise<ToolResult | InputRequiredResult> => {
    try {
      const data = await fn(args, ctx);
      return isInputRequiredResult(data) ? data : ok(data);
    } catch (err) {
      return fail(err);
    }
  };

// ───────────────────────────── User confirmation ─────────────────────────────

const confirmationSchema = z.object({
  confirm: z.boolean().describe("Tick to go ahead."),
});

/**
 * True when this request's client can show a form elicitation (2026-07-28 envelope, else the 2025 handshake).
 * `elicitation: {}` means form support (the 2025-06-18 shape); a client that declares only `url` cannot show our form.
 */
const canElicit = (server: McpServer, ctx: ServerContext): boolean => {
  const envelope = ctx.mcpReq.envelope as Record<string, any> | undefined;
  const el = (envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities())?.elicitation;
  if (!el || typeof el !== "object") return false;
  return Boolean(el.form) || Object.keys(el).length === 0;
};

// The confirmation answer comes back from the client, so on its own it proves nothing: a client could send
// `inputResponses: { confirm: … }` on the first call, or confirm one set of arguments and retry with another.
// So the server mints a `requestState` that binds the prompt to the exact tool + arguments (HMAC with a
// per-process key, 10-minute expiry) and only honours an answer that arrives with a valid state for those args.
const STATE_KEY = randomBytes(32);
const STATE_TTL_MS = 10 * 60_000;

/** JSON with sorted object keys, so the same arguments always hash the same way. */
const stableJson = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stableJson).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => (v as any)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

const argsDigest = (tool: string, args: unknown) =>
  createHash("sha256").update(`${tool}\n${stableJson(args)}`).digest("base64url");
const sign = (payload: string) => createHmac("sha256", STATE_KEY).update(payload).digest("base64url");

const mintState = (tool: string, args: unknown): string => {
  const payload = Buffer.from(JSON.stringify({ d: argsDigest(tool, args), exp: Date.now() + STATE_TTL_MS })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
};

const stateMatches = (state: unknown, tool: string, args: unknown): boolean => {
  if (typeof state !== "string") return false;
  const [payload, mac] = state.split(".");
  if (!payload || !mac) return false;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    const { d, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && exp > Date.now() && d === argsDigest(tool, args);
  } catch {
    return false;
  }
};

/**
 * Ask the user to confirm a write before it happens, using a multi-round-trip elicitation (protocol 2026-07-28;
 * the SDK's legacy shim turns it into a server→client `elicitation/create` for 2025-era clients).
 *
 * Returns `"go"` when the user confirmed these exact arguments (or the client cannot show a form, in which case
 * the host's own tool approval is the gate), `"declined"` / `"cancelled"` when the user said no or dismissed the
 * prompt, or the `input_required` result to send back.
 */
const confirmWrite = (
  server: McpServer,
  ctx: ServerContext,
  tool: string,
  args: unknown,
  message: string,
): "go" | "declined" | "cancelled" | InputRequiredResult => {
  if (!canElicit(server, ctx)) return "go";
  const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm");
  // No answer yet, or an answer not bound to a prompt we issued for these args: (re-)ask.
  if (answer.kind !== "elicit" || !stateMatches(ctx.mcpReq.requestState(), tool, args)) {
    return inputRequired({
      inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: confirmationSchema }) },
      requestState: mintState(tool, args),
    });
  }
  if (answer.action === "cancel") return "cancelled";
  const parsed = confirmationSchema.safeParse(answer.content ?? {});
  return answer.action === "accept" && parsed.success && parsed.data.confirm ? "go" : "declined";
};

/** The tool result when the user did not confirm. */
const notConfirmed = (decision: "declined" | "cancelled", what: Record<string, unknown>, nothing: string) => ({
  status: decision,
  ...what,
  message:
    decision === "declined"
      ? `The user declined; ${nothing}. Do not retry unless the user asks.`
      : `The user dismissed the confirmation without answering; ${nothing}.`,
});

const fmtPrice = (v: unknown) =>
  typeof v === "number" || (typeof v === "string" && v !== "") ? `${v} EUR` : "hidden (no API key)";

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

/**
 * Public product page on hertwill.com. The API returns only the slug, so the URL is built from it.
 * List results carry the template once (`product_url_template`) instead of a full URL per item, which would repeat
 * every slug and cost ~10% of a page's tokens; get_product, which returns a single product, gets the full `url`.
 */
const PRODUCT_PAGE_BASE = "https://hertwill.com/product/";
const PRODUCT_URL_TEMPLATE = `${PRODUCT_PAGE_BASE}{slug}`;
const productUrl = (slug: unknown) =>
  typeof slug === "string" && slug ? PRODUCT_PAGE_BASE + encodeURIComponent(slug) : undefined;

/** Add `url` (the product page) right after `slug` on a product object. */
const withUrl = (item: any) => {
  const url = productUrl(item?.slug);
  if (!url) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    out[k] = v;
    if (k === "slug") out.url = url;
  }
  return out;
};

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

  /** "\"Name\" (#id)" for confirmation messages; falls back to the bare id if the lookup fails. */
  const productName = (productId: number) =>
    client.request<any>("GET", `/v1/products/${productId}`).then(
      (r) => (r.data?.name ? `"${r.data.name}" (#${productId})` : `product #${productId}`),
      () => `product #${productId}`,
    );

  // ───────────────────────────── Catalog (public) ─────────────────────────────

  server.registerTool(
    "search_products",
    {
      title: "Search / browse products",
      description:
        "Search or browse the Hertwill dropshipping catalog with filters, sorting and pagination. " +
        "Pass `query` for full-text search; omit it to browse. Returns compact product summaries without the HTML " +
        "description or variations; call get_product for full details and variation ids. Link a product as " +
        "`meta.product_url_template` with its `slug` filled in." +
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
      outputSchema: out.searchProductsOutput,
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
      return { data, meta: { product_url_template: PRODUCT_URL_TEMPLATE, ...meta } };
    }),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product details",
      description:
        "Get full details for one catalog product by numeric id or slug, including variations (with their catalog " +
        "variation ids), its public page `url`, images, attributes, shipping, packaging and compliance data." +
        priceNote,
      inputSchema: z.object({
        id_or_slug: z.string().min(1).describe("Numeric product id (e.g. '11180') or product slug."),
        lang: z
          .enum(LANGS)
          .optional()
          .describe("Return the description in this language. Names are not translated."),
      }),
      outputSchema: out.getProductOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ id_or_slug, lang }) => {
      const path = /^\d+$/.test(id_or_slug)
        ? `/v1/products/${id_or_slug}`
        : `/v1/products/slug/${encodeURIComponent(id_or_slug)}`;
      const res = await client.request<any>("GET", path, { query: { lang } });
      return { data: withUrl(res.data), meta: res.meta ?? {} };
    }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description: "List the product category tree (id, slug, name, children). Use slugs as the `category` filter.",
      inputSchema: z.object({}),
      outputSchema: out.listCategoriesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => ({ categories: (await client.request<any>("GET", "/v1/categories")).data ?? [] })),
  );

  server.registerTool(
    "get_category",
    {
      title: "Get category",
      description: "Get one category by id or slug.",
      inputSchema: z.object({ id_or_slug: z.string().min(1) }),
      outputSchema: out.getCategoryOutput,
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
      outputSchema: out.listBrandsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ include_description }) => {
      const data = (await client.request<any>("GET", "/v1/brands")).data;
      return {
        brands: include_description ? data : omitFields(data, ["description", "return_policy", "responsible_person", "gpsr"]),
      };
    }),
  );

  server.registerTool(
    "get_brand",
    {
      title: "Get brand",
      description: "Get full details for one brand by numeric id, including return policy, GPSR and responsible person.",
      inputSchema: z.object({ brand_id: z.number().int().describe("Numeric brand id.") }),
      outputSchema: out.getBrandOutput,
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
      outputSchema: out.brandShippingOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ brand_id, destination }) => {
      const lists = (await client.request<any>("GET", `/v1/brands/${brand_id}/shipping-price-lists`)).data;
      if (!destination || !Array.isArray(lists)) return { price_lists: lists ?? [] };
      const dest = destination.toUpperCase();
      return {
        price_lists: lists.map((l: any) => ({
          ...l,
          shipping_prices: (l.shipping_prices ?? []).filter((p: any) => p.dest_iso_code === dest),
        })),
      };
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
        "sync_product; `variations` holds the (id, dropship_id) pairs. Link a product as `product_url_template` with " +
        "its `slug` filled in. " +
        "Requires HERTWILL_API_KEY.",
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
      outputSchema: out.listImportListOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ include_description, ...q }) => {
      const res: any = await client.request("GET", "/v1/import-list", { query: q as Query, requireKey: true });
      let data = res.data;
      if (!include_description) data = omitFields(data, ["description"]);
      data = slimImages(data);
      return { data: data ?? [], pagination: res.meta?.pagination, product_url_template: PRODUCT_URL_TEMPLATE };
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
      outputSchema: out.addToImportListOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ product_ids }) => ({
      results:
        (await client.request<any>("POST", "/v1/import-list/products", { body: { product_ids }, requireKey: true }))
          .data ?? [],
    })),
  );

  server.registerTool(
    "remove_from_import_list",
    {
      title: "Remove product from import list",
      description:
        "Remove a product from your store's import list. When the client supports it, the user is asked to confirm " +
        "first; if they decline, nothing is removed and the result has status 'declined' (or 'cancelled' if they " +
        "dismissed the prompt). Requires HERTWILL_API_KEY.",
      inputSchema: z.object({
        product_id: z.number().int().describe("Catalog product id (the import-list item's `id`)."),
      }),
      outputSchema: out.removeFromImportListOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args, ctx) => {
      const { product_id } = args;
      client.assertKey();
      if (canElicit(server, ctx)) {
        const name = await productName(product_id);
        const decision = confirmWrite(server, ctx, "remove_from_import_list", args, `Remove ${name} from your Hertwill import list?`);
        if (decision === "declined" || decision === "cancelled")
          return notConfirmed(decision, { product_id }, "nothing was removed");
        if (decision !== "go") return decision;
      }
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
        "`selling_price` unless overridden in `variation_prices`. When the client supports it, the user is asked to confirm " +
        "the product, price and wholesale cost first; if they decline, nothing is synced and the result has status " +
        "'declined' (or 'cancelled' if they dismissed the prompt). Either way the product stays in the import list. Runs asynchronously — check progress with get_sync_status. " +
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
      outputSchema: out.syncProductOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async (args, ctx) => {
      const { product_id, selling_price, variation_prices, currency, lang } = args;
      // Idempotent add: guarantees the product is in the import list and returns the full (id, dropship_id) pairing.
      // It only stages the product (nothing reaches the store), so it runs before the confirmation: that way invalid
      // input is rejected before the user is asked anything.
      const [added, product] = await Promise.all([
        client.request<any>("POST", "/v1/import-list/products", { body: { product_ids: [product_id] }, requireKey: true }),
        canElicit(server, ctx)
          ? client.request<any>("GET", `/v1/products/${product_id}`).then((r) => r.data, () => undefined)
          : undefined,
      ]);
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

      const overrides = Object.keys(variation_prices ?? {}).length;
      const decision = confirmWrite(
        server,
        ctx,
        "sync_product",
        args,
        `Publish ${product?.name ? `"${product.name}" (#${product_id})` : `product #${product_id}`} to your store?\n` +
          `Selling price: ${selling_price} ${currency ?? "(your store's currency)"}\n` +
          `Wholesale cost: ${fmtPrice(product?.price)}` +
          (pairs.length ? `\nVariants: ${pairs.length}${overrides ? `, ${overrides} with their own price` : ""}` : ""),
      );
      if (decision === "declined" || decision === "cancelled")
        return notConfirmed(decision, { product_id }, "nothing was synced to the store");
      if (decision !== "go") return decision;

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
      outputSchema: out.syncHealthOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async () => (await client.request<any>("GET", "/v1/sync/health", { requireKey: true })).data ?? {}),
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
      outputSchema: out.listSyncJobsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (q) => {
      const res: any = await client.request("GET", "/v1/sync/jobs", { query: q as Query, requireKey: true });
      return { data: res.data ?? [], pagination: res.meta?.pagination };
    }),
  );

  server.registerTool(
    "get_sync_status",
    {
      title: "Get product sync status",
      description: "Get the sync status of one product in your store. Requires HERTWILL_API_KEY.",
      inputSchema: z.object({ product_id: z.number().int().describe("Catalog product id.") }),
      outputSchema: out.syncStatusOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ product_id }) =>
      (await client.request<any>("GET", `/v1/sync/jobs/${product_id}`, { requireKey: true })).data ?? {},
    ),
  );
}
