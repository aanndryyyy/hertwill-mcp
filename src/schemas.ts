/**
 * Output schemas (`outputSchema`) for every tool.
 *
 * Objects are `looseObject` on purpose: they type the fields a model or client relies on and let any other field
 * the Hertwill API adds pass through, so a new API field never breaks a tool call. Fields the API does not always
 * send are optional, and ids are `number | string` because the API mixes both (brand and category ids are strings
 * in list endpoints and numbers when nested in a product).
 */
import * as z from "zod";

const id = z.union([z.number(), z.string()]);
/** Prices are `null` without an API key. */
const money = z.union([z.number(), z.string()]).nullable();

const pagination = z.looseObject({
  page: z.number(),
  per_page: z.number(),
  total: z.number(),
  page_count: z.number(),
});

const ref = z.looseObject({ id: id.optional(), name: z.string(), slug: z.string() });

const productSummary = z.looseObject({
  id: z.number().describe("Catalog product id."),
  slug: z.string(),
  name: z.string(),
  sku: z.string().nullable().optional(),
  price: money.optional().describe("Wholesale price in EUR; null without an API key."),
  sale_price: money.optional(),
  stock: z.number().nullable().optional(),
  stock_status: z.string().nullable().optional(),
  brand: ref.nullable().optional(),
  category: ref.nullable().optional(),
  images: z
    .looseObject({ featured: z.string().nullable(), gallery_count: z.number().optional() })
    .nullable()
    .optional(),
});

const variation = z.looseObject({ id: id.describe("Catalog variation id."), dropship_id: id.optional() });

const category = z.looseObject({
  id,
  slug: z.string(),
  name: z.string(),
  parent_id: id.nullable().optional(),
  children: z.array(z.looseObject({ id, slug: z.string(), name: z.string() })).optional(),
});

export const searchProductsOutput = z.object({
  data: z.array(productSummary),
  meta: z.looseObject({
    product_url_template: z.string().describe("Public product page URL; replace {slug} with the product's slug."),
    pagination: pagination.optional(),
    facets: z.array(z.unknown()).optional().describe("Only present when include_facets is true."),
  }),
});

export const getProductOutput = z.object({
  data: z.looseObject({
    id: z.number(),
    slug: z.string(),
    url: z.string().optional().describe("Public product page on hertwill.com; link to it when showing the product."),
    name: z.string(),
    price: money.optional(),
    sale_price: money.optional(),
    stock: z.number().nullable().optional(),
    stock_status: z.string().nullable().optional(),
    brand: ref.nullable().optional(),
    category: ref.nullable().optional(),
    variations: z.array(variation).nullable().optional(),
    sellable_countries: z.array(z.string()).nullable().optional(),
  }),
  meta: z.looseObject({ lang: z.string().optional() }),
});

export const listCategoriesOutput = z.object({ categories: z.array(category) });
export const getCategoryOutput = category;

const brand = z.looseObject({ id, name: z.string(), slug: z.string() });
export const listBrandsOutput = z.object({ brands: z.array(brand) });
export const getBrandOutput = brand;

export const brandShippingOutput = z.object({
  price_lists: z.array(
    z.looseObject({
      id,
      name: z.string().nullable().optional(),
      per_item: z.boolean().nullable().optional(),
      shipping_prices: z.array(z.looseObject({ dest_iso_code: z.string().optional() })).optional(),
    }),
  ),
});

const importListItem = z.looseObject({
  id: z.number().describe("Catalog product id; pass this to sync_product."),
  variations: z.array(variation).nullable().optional(),
});

export const listImportListOutput = z.object({
  data: z.array(importListItem),
  pagination: pagination.optional(),
  product_url_template: z.string().describe("Public product page URL; replace {slug} with the product's slug."),
});

export const addToImportListOutput = z.object({
  results: z.array(
    z.looseObject({
      product_id: z.number().optional(),
      status: z.string().optional().describe("e.g. 'added' or 'already_exists'."),
      variations: z.array(variation).nullable().optional(),
    }),
  ),
});

export const removeFromImportListOutput = z.looseObject({});

export const syncProductOutput = z.looseObject({
  status: z
    .string()
    .optional()
    .describe("'declined' or 'cancelled' when the user did not confirm; otherwise the API's sync status."),
  variations_submitted: z.number().optional(),
});

export const syncHealthOutput = z.looseObject({});

export const listSyncJobsOutput = z.object({
  data: z.array(z.looseObject({})),
  pagination: pagination.optional(),
});

export const syncStatusOutput = z.looseObject({});
