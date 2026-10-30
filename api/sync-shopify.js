import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const requestCache = new AsyncLocalStorage();

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_KEY = requireAnyEnv(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"]);
const SHOPIFY_SHOP = normalizeShop(requireEnv("SHOPIFY_SHOP"));

const PRODUCT_TABLE = process.env.SUPABASE_PRODUCT_TABLE || "products_richmond";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const DEFAULT_LIMIT = parseInt(process.env.SHOPIFY_SYNC_LIMIT || "5", 10);
const DEFAULT_CREATE_MISSING = process.env.SHOPIFY_CREATE_MISSING === "true";
const DEFAULT_SYNC_IMAGES = process.env.SHOPIFY_SYNC_IMAGES === "true";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const shopify = axios.create({
  baseURL: `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}`,
  timeout: parseInt(process.env.SHOPIFY_TIMEOUT_MS || "45000", 10)
});

export default function handler(req, res) {
  return requestCache.run({ products: new Map(), variants: new Map() }, () => handleRequest(req, res));
}

async function handleRequest(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const authorised = [process.env.AUDIT_SECRET, process.env.CRON_SECRET].filter(Boolean)
    .some(secret => req.headers.authorization === `Bearer ${secret}`);
  if (!authorised) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    if (readBooleanQuery(req.query.cleanDuplicateImages, false)) {
      return await cleanDuplicateImages(req, res);
    }
    if (readBooleanQuery(req.query.stockBatch, false)) {
      return await syncStockBatch(req, res);
    }
    if (readBooleanQuery(req.query.plan, false)) {
      const rows = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from(PRODUCT_TABLE)
          .select("item_code,title,status,shopify_product_id,last_richmond_sync,last_sync_error,needs_stock_update,needs_price_update,needs_compare_at_price_update,needs_status_update,needs_description_update,needs_images_update")
          .order("item_code").range(offset, offset + 499);
        if (error) throw error;
        rows.push(...data);
        if (data.length < 500) break;
      }
      return res.status(200).json({ ok: true, products: rows, configured_location_id: process.env.SHOPIFY_LOCATION_ID || null });
    }
    const startedAt = Date.now();
    const now = new Date().toISOString();

    const limit = readIntQuery(req.query.limit, DEFAULT_LIMIT, 1, 50);
    const itemCode = cleanString(req.query.item_code);
    const id = cleanString(req.query.id);
    const dryRun = readBooleanQuery(req.query.dryRun, false);
    const linkOnly = readBooleanQuery(req.query.linkOnly, false);
    const createMissing = readBooleanQuery(req.query.createMissing, DEFAULT_CREATE_MISSING);
    const syncImages = readBooleanQuery(req.query.syncImages, DEFAULT_SYNC_IMAGES);
    const phase = cleanString(req.query.phase) || "all";
    if (!["all", "priority", "information", "images"].includes(phase)) {
      return res.status(400).json({ ok: false, error: "Invalid phase" });
    }

    const accessToken = await getShopifyAccessToken();
    const headers = {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    };

    const products = await fetchProductsToSync({ id, itemCode, limit, linkOnly, syncImages });

    if (products.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "No products to sync",
        count: 0
      });
    }

    const locationId = process.env.SHOPIFY_LOCATION_ID || null;
    const results = [];

    for (const product of products) {
      const result = await syncOneProduct({
        product,
        headers,
        locationId,
        now,
        dryRun,
        linkOnly,
        createMissing,
        syncImages,
        phase,
        managedDraft: readBooleanQuery(req.query.managedDraft, false)
      });

      results.push(result);
    }

    return res.status(200).json({
      ok: true,
      table: PRODUCT_TABLE,
      count: products.length,
      dryRun,
      linkOnly,
      createMissing,
      syncImages,
      phase,
      results,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    console.error("Shopify sync failed; inspect response status, not credentials.");
    return res.status(500).json({
      ok: false,
      error: "Shopify sync failed",
      upstream_status: error.response?.status || null
    });
  }
}

async function syncOneProduct({
  product,
  headers,
  locationId,
  now,
  dryRun,
  linkOnly,
  createMissing,
  syncImages,
  phase = "all",
  managedDraft = false
}) {
  const skuCandidates = buildSkuCandidates(product);
  const result = {
    id: product.id,
    item_code: product.item_code,
    skuCandidates,
    action: null,
    synced: [],
    skipped: [],
    errors: []
  };

  try {
    const priority = phase === "all" || phase === "priority";
    const information = phase === "all" || phase === "information";
    const media = phase === "all" || phase === "images";
    const needsWork = (priority && (product.needs_price_update || product.needs_compare_at_price_update ||
      (product.needs_stock_update && locationId))) ||
      (information && (product.needs_status_update || product.needs_description_update)) ||
      (media && syncImages && product.needs_images_update);
    if (product.shopify_product_id && product.shopify_variant_id && !needsWork && !linkOnly) {
      result.action = "unchanged";
      if (product.needs_stock_update && !locationId && priority) result.skipped.push("stock_destination_not_configured");
      return result;
    }
    let match = await findShopifyMatch(product, skuCandidates, headers);

    if (!match && !createMissing) {
      const message =
        `No Shopify product found for SKU(s): ${skuCandidates.join(", ")}. ` +
        "Creation is disabled to avoid duplicates.";

      if (!dryRun) await markProductError(product.id, message);
      result.action = "not_found";
      result.errors.push(message);
      return result;
    }

    if (linkOnly && !match) {
      const message = `No Shopify product found for SKU(s): ${skuCandidates.join(", ")}.`;

      await markProductError(product.id, message);
      result.action = "not_found";
      result.errors.push(message);
      return result;
    }

    if (!match && product.status !== "active") {
      return { ...result, action: "skipped", skipped: ["supplier_not_active"] };
    }
    if (!match) {
      const supplierStatus = product.raw_data?.details?.["Product Status"];
      if (supplierStatus && supplierStatus !== "Actief") {
        return { ...result, action: "skipped", skipped: ["no_creation_for_end_of_series"] };
      }
      if (!(Number(product.price) > 0)) throw new Error("Invalid price: creation refused");
      if (dryRun) {
        result.action = "would_create";
        return result;
      }

      match = await createShopifyProduct(product, headers, information);
      result.action = "created";
    } else {
      const live = await fetchProduct(match.productId, headers);
      if (live.vendor !== "Richmond Interiors") throw new Error("Vendor mismatch");
      const exactVariant = (live.variants || []).find(v => String(v.id) === String(match.variantId));
      if (!exactVariant || !skuCandidates.includes(cleanString(exactVariant.sku))) throw new Error("Stored SKU mismatch");
      const ownedDraft = live.status === "draft" && (managedDraft ||
        String(live.tags || "").split(",").some(tag => tag.trim() === "richmond-middleware-created"));
      if (live.status !== "active" && !ownedDraft) {
        result.action = "skipped";
        result.skipped.push("shopify_" + live.status + "_preserved");
        return result;
      }
      if (product.status !== "active") {
        result.action = "skipped";
        result.skipped.push("supplier_discontinued_requires_review");
        return result;
      }
      result.action = "updated";
    }

    if (linkOnly) {
      if (dryRun) {
        result.action = "would_link";
        result.shopify_product_id = String(match.productId);
        result.shopify_variant_id = String(match.variantId);
        result.shopify_inventory_item_id = String(match.inventoryItemId || "");
        return result;
      }

      await saveShopifyIds(product.id, match);
      await clearProductError(product.id);

      return {
        ...result,
        action: "linked",
        shopify_product_id: String(match.productId),
        shopify_variant_id: String(match.variantId),
        shopify_inventory_item_id: match.inventoryItemId ? String(match.inventoryItemId) : null
      };
    }

    if (dryRun) {
      result.shopify_product_id = String(match.productId);
      result.shopify_variant_id = String(match.variantId);
      result.shopify_inventory_item_id = String(match.inventoryItemId || "");
      result.action = `would_${result.action}`;
      return result;
    }

    const clearedFlags = {};

    if (information && (product.needs_status_update || product.needs_description_update)) {
      // Preserve existing Shopify title/body/status; refresh the existing technical metafields.
      if (result.action !== "created") await upsertProductMetafields(product, match.productId, headers);
      result.skipped.push("existing_title_description_status_preserved");

      if (product.needs_status_update) {
        clearedFlags.needs_status_update = false;
        result.skipped.push("status_preserved");
      }

      if (product.needs_description_update) {
        clearedFlags.needs_description_update = false;
        result.synced.push("technical_metafields");
      }
    }

    if (priority && (product.needs_price_update || product.needs_compare_at_price_update)) {
      await updateVariantPricing(product, match.variantId, headers);
      clearedFlags.needs_price_update = false;
      clearedFlags.needs_compare_at_price_update = false;
      result.synced.push("price");
    }

    if (priority && product.needs_stock_update && locationId) {
      // All stock writes now use the bulk path, which checks manual overrides and CAS.
      result.skipped.push("stock_handled_by_batch");
    }

    if (priority && product.needs_stock_update && !locationId) {
      result.skipped.push("stock_destination_not_configured");
    }
    if (media && product.needs_images_update) {
      if (syncImages) {
        const imageResult = await appendMissingImages(product, match.productId, headers);
        clearedFlags.needs_images_update = false;
        result.synced.push("images");

        if (imageResult.skippedInvalid > 0) {
          result.skipped.push(`invalid_images:${imageResult.skippedInvalid}`);
        }
      } else {
        result.skipped.push("images");
      }
    }

    const { error: saveError } = await supabase
      .from(PRODUCT_TABLE)
      .update({
        ...clearedFlags,
        shopify_product_id: String(match.productId),
        shopify_variant_id: String(match.variantId),
        shopify_inventory_item_id: match.inventoryItemId ? String(match.inventoryItemId) : null,
        last_shopify_sync: now,
        last_synced_at: now,
        last_sync_error: null,
        sync_retry_count: 0
      })
      .eq("id", product.id);
    if (saveError) throw saveError;

    return {
      ...result,
      shopify_product_id: String(match.productId),
      shopify_variant_id: String(match.variantId),
      shopify_inventory_item_id: match.inventoryItemId ? String(match.inventoryItemId) : null
    };
  } catch (error) {
    const message = formatShopifyError(error);
    console.error(`Shopify sync error for ${product.item_code}:`, message);
    if (!dryRun) await markProductError(product.id, message);

    result.action = "error";
    result.errors.push(message);
    return result;
  }
}

async function fetchProductsToSync({ id, itemCode, limit, linkOnly, syncImages }) {
  if (id) {
    const { data, error } = await supabase
      .from(PRODUCT_TABLE)
      .select("*")
      .eq("id", id)
      .limit(1);

    if (error) throw error;
    return data || [];
  }

  if (itemCode) {
    const byItemCode = await fetchByColumn("item_code", itemCode, limit);
    if (byItemCode.length > 0) return byItemCode;
    return fetchByColumn("item_code_new", itemCode, limit);
  }

  if (linkOnly) {
    const { data, error } = await supabase
      .from(PRODUCT_TABLE)
      .select("*")
      .or(
        [
          "shopify_product_id.is.null",
          "shopify_variant_id.is.null",
          "shopify_inventory_item_id.is.null"
        ].join(",")
      )
      .is("last_sync_error", null)
      .order("updated_at", { ascending: true, nullsFirst: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  const pendingFlags = [
    "needs_stock_update.eq.true",
    "needs_price_update.eq.true",
    "needs_compare_at_price_update.eq.true",
    "needs_status_update.eq.true",
    "needs_description_update.eq.true"
  ];

  if (syncImages) {
    pendingFlags.push("needs_images_update.eq.true");
  }

  const { data, error } = await supabase
    .from(PRODUCT_TABLE)
    .select("*")
    .or(pendingFlags.join(","))
    .is("last_sync_error", null)
    .order("updated_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function fetchByColumn(column, value, limit) {
  const { data, error } = await supabase
    .from(PRODUCT_TABLE)
    .select("*")
    .eq(column, value)
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function findShopifyMatch(product, skuCandidates, headers) {
  const storedProductId = toLegacyId(product.shopify_product_id);
  const storedVariantId = toLegacyId(product.shopify_variant_id || product.variant_id);

  // One product GET supplies status, all variants, prices and images.
  if (storedProductId) {
    const live = await fetchProduct(storedProductId, headers);
    const variant = storedVariantId
      ? (live.variants || []).find(v => String(v.id) === String(storedVariantId))
      : chooseVariant(live.variants || [], skuCandidates);
    if (!variant || !skuCandidates.includes(cleanString(variant.sku))) throw new Error("Stored product/variant SKU mismatch");
    return { productId: live.id, variantId: variant.id, inventoryItemId: variant.inventory_item_id };
  }

  if (storedVariantId) {
    const variant = await fetchVariant(storedVariantId, headers);

    return {
      productId: variant.product_id,
      variantId: variant.id,
      inventoryItemId: variant.inventory_item_id
    };
  }

  if (storedProductId) {
    const productPayload = await fetchProduct(storedProductId, headers);
    const variant = chooseVariant(productPayload.variants || [], skuCandidates);

    if (!variant) {
      throw new Error(
        `Stored Shopify product ${storedProductId} exists, but no matching variant SKU was found.`
      );
    }

    return {
      productId: productPayload.id,
      variantId: variant.id,
      inventoryItemId: variant.inventory_item_id
    };
  }

  for (const sku of skuCandidates) {
    const variants = await searchVariantsBySku(sku, headers);
    const exactMatches = variants.filter((variant) => cleanString(variant.sku) === sku);

    if (exactMatches.length > 1) {
      const activeMatches = [];
      for (const variant of exactMatches) {
        const live = await fetchProduct(variant.product_id, headers);
        if (live.vendor === "Richmond Interiors" && live.status === "active") activeMatches.push(variant);
      }
      if (activeMatches.length === 1) {
        const variant = activeMatches[0];
        return { productId: variant.product_id, variantId: variant.id, inventoryItemId: variant.inventory_item_id };
      }
      throw new Error(
        `Duplicate Shopify variants found for SKU ${sku}. Fix duplicates in Shopify before syncing.`
      );
    }

    if (exactMatches.length === 1) {
      const variant = exactMatches[0];

      return {
        productId: variant.product_id,
        variantId: variant.id,
        inventoryItemId: variant.inventory_item_id
      };
    }
  }

  return null;
}

async function createShopifyProduct(product, headers, syncInformation = true) {
  const payload = {
    product: {
      title: product.title || product.item_code,
      body_html: product.description_fr || "",
      vendor: "Richmond Interiors",
      product_type: product.product_type || "",
      status: product.status === "archived" ? "archived" : "draft",
      tags: "richmond-middleware-created",
      variants: [
        {
          sku: product.item_code_new || product.item_code,
          barcode: product.ean || undefined,
          price: money(product.price),
          compare_at_price: product.compare_at_price ? money(product.compare_at_price) : null,
          inventory_management: "shopify"
        }
      ]
    }
  };

  const response = await shopify.post("/products.json", payload, { headers });
  const created = response.data.product;
  const variant = created.variants[0];

  cacheProduct(created);
  if (syncInformation) await upsertProductMetafields(product, created.id, headers);

  return {
    productId: created.id,
    variantId: variant.id,
    inventoryItemId: variant.inventory_item_id
  };
}

async function updateProductDetails(product, productId, headers) {
  const payload = {
    product: {
      id: Number(productId),
      title: product.title || product.item_code,
      body_html: product.description_fr || "",
      vendor: "Richmond Interiors",
      product_type: product.product_type || "",
      status: product.status === "archived" ? "archived" : "active"
    }
  };

  await shopify.put(`/products/${productId}.json`, payload, { headers });
  await upsertProductMetafields(product, productId, headers);
}

async function updateVariantPricing(product, variantId, headers) {
  if (!(Number(product.price) > 0)) throw new Error("Invalid price: update refused");
  const current = await fetchVariant(variantId, headers);
  const equal = (a, b) => (a == null || a === "") ? (b == null || b === "") :
    (b != null && b !== "" && Math.abs(Number(a) - Number(b)) < 0.009);
  if (equal(current.price, product.price) && equal(current.compare_at_price, product.compare_at_price)) return;
  const payload = {
    variant: {
      id: Number(variantId),
      sku: product.item_code_new || product.item_code,
      barcode: product.ean || undefined,
      price: money(product.price),
      compare_at_price: product.compare_at_price ? money(product.compare_at_price) : null,
      inventory_management: "shopify"
    }
  };

  await shopify.put(`/variants/${variantId}.json`, payload, { headers });
}

async function setInventoryLevel(product, inventoryItemId, locationId, headers) {
  const desired = Number.parseInt(product.stock_quantity, 10);
  if (!Number.isFinite(desired) || desired < 0) throw new Error("Unknown supplier stock; quantity preserved");
  const response = await shopify.get("/inventory_levels.json", {
    headers, params: { inventory_item_ids: String(inventoryItemId), location_ids: String(locationId) }
  });
  const current = response.data.inventory_levels?.find(l => String(l.location_id) === String(locationId));
  if (!current) throw new Error("Variant not assigned to configured stock location; no relocation performed");
  if (current.available === desired) return;
  await shopify.post(
    "/inventory_levels/set.json",
    {
      location_id: Number(locationId),
      inventory_item_id: Number(inventoryItemId),
      available: desired
    },
    { headers }
  );
}

async function appendMissingImages(product, productId, headers) {
  const desiredUrls = Array.isArray(product.images)
    ? product.images.map(normalizeImageUrl).filter(Boolean)
    : [];

  const summary = {
    added: 0,
    alreadyExists: 0,
    skippedInvalid: 0
  };

  if (desiredUrls.length === 0) return summary;

  const existingImages = (await fetchProduct(productId, headers)).images || [];
  const existingFilenames = new Set(
    existingImages
      .flatMap((image) => [filenameFromUrl(image.src || ""), richmondImageReference(image.alt, product.item_code)])
      .filter(Boolean)
  );

  for (const url of desiredUrls) {
    const filename = filenameFromUrl(url);
    if (filename && existingFilenames.has(filename)) {
      summary.alreadyExists += 1;
      continue;
    }

    try {
      await shopify.post(
        `/products/${productId}/images.json`,
        {
          image: {
            src: url,
            alt: `Richmond ${product.item_code || ""} ${filename || ""}`.trim()
          }
        },
        { headers }
      );
    } catch (error) {
      if (isInvalidImageUrlError(error)) {
        summary.skippedInvalid += 1;
        continue;
      }

      throw error;
    }

    if (filename) existingFilenames.add(filename);
    summary.added += 1;
  }

  return summary;
}

async function upsertProductMetafields(product, productId, headers) {
  const metafields = buildMetafields(product);
  if (metafields.length === 0) return;

  const response = await shopify.get(`/products/${productId}/metafields.json?namespace=custom`, {
    headers
  });

  const existing = response.data.metafields || [];

  for (const metafield of metafields) {
    const current = existing.find(
      (item) => item.namespace === metafield.namespace && item.key === metafield.key
    );

    if (current && metafieldValuesEqual(current, metafield)) continue;

    if (current) {
      await shopify.put(
        `/metafields/${current.id}.json`,
        {
          metafield: {
            id: current.id,
            value: metafield.value,
            type: metafield.type
          }
        },
        { headers }
      );
    } else {
      await shopify.post(
        `/products/${productId}/metafields.json`,
        { metafield },
        { headers }
      );
    }
  }
}

function buildMetafields(product) {
  return [
    numberMetafield("volume", product.volume),
    numberMetafield("weight", product.weight),
    numberMetafield("depth", product.depth),
    numberMetafield("height", product.height),
    numberMetafield("width", product.width),
    textMetafield("color_richmond", product.color),
    jsonMetafield("materials_richmond", splitMaterials(product.materials))
  ].filter(Boolean);
}

function numberMetafield(key, value) {
  if (value === null || value === undefined || value === "") return null;

  return {
    namespace: "custom",
    key,
    value: String(value),
    type: "number_decimal"
  };
}

function textMetafield(key, value) {
  const text = cleanString(value);
  if (!text) return null;

  return {
    namespace: "custom",
    key,
    value: text,
    type: "single_line_text_field"
  };
}

function jsonMetafield(key, value) {
  return {
    namespace: "custom",
    key,
    value: JSON.stringify(value),
    type: "json"
  };
}

async function getShopifyAccessToken() {
  const { data, error } = await supabase
    .from("shopify_auth")
    .select("access_token")
    .single();

  if (error) throw error;
  if (!data?.access_token) throw new Error("Missing Shopify access token");

  return data.access_token;
}

async function getLocationId(headers) {
  if (process.env.SHOPIFY_LOCATION_ID) return process.env.SHOPIFY_LOCATION_ID;

  const response = await shopify.get("/locations.json", { headers });
  const location = response.data.locations?.[0];

  if (!location?.id) throw new Error("No Shopify location found");
  return location.id;
}

async function fetchVariant(variantId, headers) {
  const cache = requestCache.getStore();
  if (cache?.variants.has(String(variantId))) return cache.variants.get(String(variantId));
  const response = await shopify.get(`/variants/${variantId}.json`, { headers });
  cache?.variants.set(String(variantId), response.data.variant);
  return response.data.variant;
}

async function fetchInventoryItemId(variantId, headers) {
  const variant = await fetchVariant(variantId, headers);
  return variant.inventory_item_id;
}

async function fetchProduct(productId, headers) {
  const cache = requestCache.getStore();
  if (cache?.products.has(String(productId))) return cache.products.get(String(productId));
  const response = await shopify.get(`/products/${productId}.json`, { headers });
  cacheProduct(response.data.product);
  return response.data.product;
}

function cacheProduct(product) {
  const cache = requestCache.getStore();
  if (!cache || !product) return;
  cache.products.set(String(product.id), product);
  for (const variant of product.variants || []) cache.variants.set(String(variant.id), variant);
}

function metafieldValuesEqual(a, b) {
  if (a.type !== b.type) return false;
  if (b.type === "number_decimal" || b.type === "number_integer") {
    return Number.isFinite(Number(a.value)) && Number(a.value) === Number(b.value);
  }
  if (b.type === "json") {
    try { return JSON.stringify(typeof a.value === "string" ? JSON.parse(a.value) : a.value) ===
      JSON.stringify(typeof b.value === "string" ? JSON.parse(b.value) : b.value); } catch { return false; }
  }
  return String(a.value) === String(b.value);
}

// Bulk stock-only processing. Uses the existing products_richmond table and token.
// GraphQL reads and writes up to 50 variants per call, with compare-and-swap protection.
async function syncStockBatch(req, res) {
  const location = process.env.SHOPIFY_LOCATION_ID;
  if (!/^\d+$/.test(location || "")) return res.status(503).json({ ok: false, error: "Configure SHOPIFY_LOCATION_ID before stock writes" });
  if (API_VERSION < "2026-04") return res.status(503).json({ ok: false, error: "Stock batches require API version 2026-04 or newer" });
  const body = req.body || {};
  let codes = body.item_codes;
  if (!codes && req.method === "GET") {
    const { data: pending, error } = await supabase.from(PRODUCT_TABLE).select("item_code")
      .eq("needs_stock_update", true).not("shopify_variant_id", "is", null)
      .order("item_code").limit(50);
    if (error) throw error;
    codes = pending.map(row => row.item_code);
    if (!codes.length) return res.status(200).json({ ok: true, stock_only: true, count: 0, results: [] });
  }
  if (!Array.isArray(codes) || !codes.length || codes.length > 50 ||
      codes.some(code => typeof code !== "string" || !/^\d{6}$/.test(code)) || new Set(codes).size !== codes.length) {
    return res.status(400).json({ ok: false, error: "Provide 1 to 50 unique item_codes" });
  }
  const apply = body.apply === true || (req.method === "GET" && req.query.apply === "true");
  const managedDrafts = new Set(Array.isArray(body.managed_draft_codes) ? body.managed_draft_codes : []);
  const { data: rows, error } = await supabase.from(PRODUCT_TABLE).select("*").in("item_code", codes);
  if (error) throw error;
  const token = await getShopifyAccessToken();
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const gql = async (query, variables) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await shopify.post("/graphql.json", { query, variables }, { headers });
      if (response.data.errors?.length) {
        if (attempt < 2 && response.data.errors.every(e => e.extensions?.code === "THROTTLED")) {
          await new Promise(resolve => setTimeout(resolve, 3000)); continue;
        }
        throw new Error("Shopify GraphQL stock query failed: " + response.data.errors.map(e => e.message).join("; "));
      }
      if (!response.data.data) throw new Error("Invalid GraphQL data");
      return response.data.data;
    }
  };
  const query = `query RichmondStockBatch($ids: [ID!]!, $location: ID!) {
    location(id: $location) { id name isActive }
    nodes(ids: $ids) { ... on ProductVariant {
      id sku product { id status vendor tags manualStock: metafield(namespace: "custom", key: "richmond_stock_manual") { value } }
      inventoryItem { id tracked inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
    } }
  }`;
  const gid = (type, id) => `gid://shopify/${type}/${toLegacyId(id)}`;
  const valid = rows.filter(row => /^\d+$/.test(toLegacyId(row.shopify_variant_id) || ""));
  const ids = valid.map(row => gid("ProductVariant", row.shopify_variant_id));
  if (new Set(ids).size !== ids.length) return res.status(409).json({ ok: false, error: "Duplicate stored variant IDs: stock writes refused" });
  const results = codes.filter(code => !rows.some(row => row.item_code === code)).map(item_code => ({ item_code, action: "error", error: "Reference absent from Supabase" }));
  if (!ids.length) return res.status(200).json({ ok: true, stock_only: true, results: [...results, ...rows.map(row => ({ item_code: row.item_code, action: "skipped", reason: "No stored variant" }))] });
  const variables = { ids, location: gid("Location", location) };
  const data = await gql(query, variables);
  if (!data.location?.isActive) return res.status(409).json({ ok: false, error: "Configured Shopify location is missing or inactive" });
  const nodes = new Map(data.nodes.filter(Boolean).map(node => [node.id, node]));
  const changes = [], completed = [];
  for (const row of rows) {
    const result = { item_code: row.item_code, action: "skipped" };
    const node = nodes.get(gid("ProductVariant", row.shopify_variant_id));
    const stamp = String(row.last_richmond_sync || "");
    const age = Date.now() - Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(stamp) ? stamp : stamp + "Z");
    if (!Number.isFinite(age) || age > 7 * 3600000) result.reason = "Supplier stock older than seven hours; refresh required";
    else if (!node || node.product.vendor !== "Richmond Interiors" ||
      node.product.id !== gid("Product", row.shopify_product_id) ||
      ![row.item_code, row.item_code_new].includes(cleanString(node.sku))) {
      result.action = "error"; result.error = "Live Shopify product/variant/SKU mismatch";
    } else if (node.product.manualStock?.value === "true") { result.reason = "Manual stock exception preserved"; completed.push(row.id); }
    else if (node.product.status !== "ACTIVE" && !(node.product.status === "DRAFT" &&
      (node.product.tags.includes("richmond-middleware-created") || managedDrafts.has(row.item_code)))) { result.reason = "Archived or merchant draft preserved"; completed.push(row.id); }
    else if (!node.inventoryItem?.tracked) result.reason = "Inventory tracking configuration preserved";
    else if (!node.inventoryItem.inventoryLevel) result.reason = "Not stocked at configured location; no relocation";
    else if (!Number.isInteger(Number(row.stock_quantity)) || row.stock_quantity == null || Number(row.stock_quantity) < 0) {
      result.action = "error"; result.error = "Invalid supplier stock";
    } else {
      const current = node.inventoryItem.inventoryLevel.quantities.find(q => q.name === "available")?.quantity;
      if (!Number.isInteger(current)) { result.action = "error"; result.error = "Missing live available quantity"; }
      else {
        result.before = current; result.desired = Number(row.stock_quantity);
        result.action = current === result.desired ? "unchanged" : apply ? "pending_verification" : "would_update";
        if (result.action === "unchanged") completed.push(row.id);
        else changes.push({ row, node, result });
      }
    }
    results.push(result);
  }
  let mutationErrors = [];
  if (apply && changes.length) {
    const mutation = `mutation RichmondSetStock($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) {
        userErrors { field message code }
      }
    }`;
    const response = await gql(mutation, { key: randomUUID(), input: {
      name: "available", reason: "correction",
      quantities: changes.map(({node, result}) => ({ inventoryItemId: node.inventoryItem.id,
        locationId: variables.location, quantity: result.desired, changeFromQuantity: result.before }))
    } });
    mutationErrors = response.inventorySetQuantities?.userErrors || [];
    const verified = await gql(query, variables);
    const verifiedById = new Map(verified.nodes.filter(Boolean).map(node => [node.id, node]));
    for (const { row, node, result } of changes) {
      const after = verifiedById.get(node.id)?.inventoryItem?.inventoryLevel?.quantities.find(q => q.name === "available")?.quantity;
      result.after = after;
      if (after === result.desired) { result.action = "updated_and_verified"; completed.push(row.id); }
      else { result.action = "error"; result.error = "Stock changed concurrently or update rejected; retry this reference only"; }
    }
  }
  if (apply && completed.length) {
    const { error: saved } = await supabase.from(PRODUCT_TABLE).update({ needs_stock_update: false }).in("id", completed);
    if (saved) throw saved;
  }
  return res.status(200).json({ ok: true, stock_only: true, apply, location: data.location,
    mutation_errors: mutationErrors, results });
}

async function searchVariantsBySku(sku, headers) {
  const query = `
    query FindVariantBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          legacyResourceId
          sku
          product {
            id
            legacyResourceId
          }
          inventoryItem {
            id
            legacyResourceId
          }
        }
      }
    }
  `;

  const response = await shopify.post(
    "/graphql.json",
    {
      query,
      variables: {
        query: buildSkuSearchQuery(sku)
      }
    },
    { headers }
  );

  if (response.data.errors?.length) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return (response.data.data?.productVariants?.nodes || []).map((variant) => ({
    id: String(variant.legacyResourceId || legacyIdFromGid(variant.id)),
    sku: variant.sku,
    product_id: String(
      variant.product?.legacyResourceId || legacyIdFromGid(variant.product?.id)
    ),
    inventory_item_id: String(
      variant.inventoryItem?.legacyResourceId || legacyIdFromGid(variant.inventoryItem?.id)
    )
  }));
}

async function saveShopifyIds(productId, match) {
  const { error } = await supabase
    .from(PRODUCT_TABLE)
    .update({
      shopify_product_id: String(match.productId),
      shopify_variant_id: String(match.variantId),
      shopify_inventory_item_id: match.inventoryItemId ? String(match.inventoryItemId) : null
    })
    .eq("id", productId);

  if (error) throw error;
}

async function markProductError(productId, message) {
  const { data: current } = await supabase
    .from(PRODUCT_TABLE)
    .select("sync_retry_count")
    .eq("id", productId)
    .single();

  await supabase
    .from(PRODUCT_TABLE)
    .update({
      last_sync_error: message,
      sync_retry_count: (current?.sync_retry_count || 0) + 1
    })
    .eq("id", productId);
}

async function clearProductError(productId) {
  await supabase
    .from(PRODUCT_TABLE)
    .update({
      last_sync_error: null,
      sync_retry_count: 0
    })
    .eq("id", productId);
}

function chooseVariant(variants, skuCandidates) {
  const candidateSet = new Set(skuCandidates);
  const exact = variants.filter((variant) => candidateSet.has(cleanString(variant.sku)));

  if (exact.length > 1) {
    throw new Error("Stored Shopify product has multiple variants matching Richmond SKUs.");
  }

  if (exact.length === 1) return exact[0];
  // No fallback to an unrelated single variant.

  return null;
}

function buildSkuCandidates(product) {
  return unique([
    product.item_code_new,
    product.item_code,
    product.specs?.richmond_item_code_legacy,
    product.ean
  ].map(cleanString).filter(Boolean));
}

function splitMaterials(value) {
  const text = cleanString(value);
  if (!text) return [];
  return text.split(/[|,/]/).map(cleanString).filter(Boolean);
}

function normalizeImageUrl(value) {
  const text = cleanString(value);
  if (!text) return "";

  try {
    const url = new URL(text);
    url.pathname = url.pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/");

    return url.toString();
  } catch {
    return text;
  }
}

function rawFilenameFromUrl(url) {
  const text = cleanString(url);
  if (!text) return "";

  try {
    return decodeURIComponent(new URL(text).pathname.split("/").pop() || "");
  } catch {
    return text.split("?")[0].split("/").pop() || "";
  }
}

function money(value) {
  const number = Number(value || 0);
  return number.toFixed(2);
}

function cleanString(value) {
  if (Array.isArray(value)) return cleanString(value[0]);
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function unique(values) {
  return [...new Set(values)];
}

function toLegacyId(value) {
  const text = cleanString(value);
  if (!text || text === "null") return null;

  const match = text.match(/(\d+)$/);
  return match ? match[1] : text;
}

function legacyIdFromGid(value) {
  const text = cleanString(value);
  const match = text.match(/(\d+)$/);
  return match ? match[1] : "";
}

function buildSkuSearchQuery(sku) {
  const value = cleanString(sku);
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return `sku:${value}`;
  }

  return `sku:${JSON.stringify(value)}`;
}

function normalizeShop(value) {
  const text = cleanString(value)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  return text.includes(".myshopify.com") ? text : `${text}.myshopify.com`;
}

function readIntQuery(value, fallback, min, max) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = parseInt(raw ?? `${fallback}`, 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(safe, min), max);
}

function readBooleanQuery(value, fallback) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function isInvalidImageUrlError(error) {
  const text = formatShopifyError(error).toLowerCase();
  return text.includes("image") && text.includes("invalid");
}

function formatShopifyError(error) {
  if (error.response?.data) {
    return JSON.stringify(error.response.data);
  }

  return error.message;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireAnyEnv(names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }

  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

function filenameFromUrl(url) {
  return rawFilenameFromUrl(url)
    .replace(/_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig, "")
    .replace(/_\d+x\d*(?=\.[^.]+$)/, "")
    .replace(/_2B/ig, "+")
    .replace(/^-+/, "")
    .normalize("NFC").toLowerCase();
}

function richmondImageReference(alt, code) {
  const prefix = `Richmond ${code} `;
  if (!String(alt || "").startsWith(prefix)) return "";
  return filenameFromUrl(String(alt).slice(prefix.length));
}

// Only images explicitly labelled by this importer are eligible. No global file deletion.
async function cleanDuplicateImages(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST required" });
  const body = req.body || {};
  const productId = String(body.product_id || "");
  const code = String(body.item_code || "");
  if (!/^\d+$/.test(productId) || !/^\d+$/.test(code)) return res.status(400).json({ ok: false, error: "Invalid target" });
  const headers = { "X-Shopify-Access-Token": await getShopifyAccessToken() };
  const get = async () => (await shopify.get(`/products/${productId}.json`, { headers })).data.product;
  const product = await get();
  if (product.vendor !== "Richmond Interiors" || !product.variants.some(v => String(v.sku) === code)) {
    return res.status(409).json({ ok: false, error: "Product identity mismatch" });
  }
  const protectedIds = new Set(product.variants.map(v => String(v.image_id || "")));
  const groups = new Map();
  for (const image of product.images || []) {
    const ref = richmondImageReference(image.alt, code);
    if (!ref) continue;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(image);
  }
  const candidates = [];
  for (const group of groups.values()) {
    // Keep the first gallery occurrence, and every image associated with a variant.
    for (const image of group.slice(1)) if (!protectedIds.has(String(image.id))) candidates.push(image);
  }
  const approved = new Set((Array.isArray(body.approved_ids) ? body.approved_ids : []).map(String));
  const selected = candidates.filter(i => approved.has(String(i.id))).slice(0, 10);
  const apply = body.apply === true;
  const deleted = [];
  if (apply) for (const image of selected) {
    await shopify.delete(`/products/${productId}/images/${image.id}.json`, { headers });
    deleted.push(String(image.id));
  }
  if (apply && deleted.length) {
    const after = await get();
    if (after.images.some(i => deleted.includes(String(i.id)))) throw Error("Image deletion verification failed");
    const keptIds = (product.images || []).filter(i => !deleted.includes(String(i.id))).map(i => String(i.id));
    if (keptIds.some(id => !after.images.some(i => String(i.id) === id))) throw Error("Unexpected gallery change");
  }
  return res.status(200).json({ ok: true, apply, product_id: productId, item_code: code,
    candidates: candidates.map(i => ({ id: String(i.id), src: i.src, alt: i.alt })), deleted,
    preserved_variant_images: [...protectedIds].filter(Boolean) });
}

// Serialize Shopify calls inside each invocation and respect temporary throttling.
let lastShopifyRequest = 0;
shopify.interceptors.request.use(async config => {
  const wait = Math.max(0, 700 - (Date.now() - lastShopifyRequest));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastShopifyRequest = Date.now();
  return config;
});
shopify.interceptors.response.use(response => response, async error => {
  const config = error.config;
  if (error.response?.status === 429 && config && (config._syncRetries || 0) < 3) {
    config._syncRetries = (config._syncRetries || 0) + 1;
    const delay = Math.min(10000, Math.max(2000, (Number(error.response.headers["retry-after"]) || 2) * 1000));
    await new Promise(resolve => setTimeout(resolve, delay));
    return shopify.request(config);
  }
  throw error;
});

