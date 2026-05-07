import axios from "axios";
import { createClient } from "@supabase/supabase-js";

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

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const startedAt = Date.now();
    const now = new Date().toISOString();

    const limit = readIntQuery(req.query.limit, DEFAULT_LIMIT, 1, 50);
    const itemCode = cleanString(req.query.item_code);
    const id = cleanString(req.query.id);
    const dryRun = readBooleanQuery(req.query.dryRun, false);
    const linkOnly = readBooleanQuery(req.query.linkOnly, false);
    const createMissing = readBooleanQuery(req.query.createMissing, DEFAULT_CREATE_MISSING);
    const syncImages = readBooleanQuery(req.query.syncImages, DEFAULT_SYNC_IMAGES);

    const accessToken = await getShopifyAccessToken();
    const headers = {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    };

    const products = await fetchProductsToSync({ id, itemCode, limit, linkOnly });

    if (products.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "No products to sync",
        count: 0
      });
    }

    const locationId = await getLocationId(headers);
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
        syncImages
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
      results,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    console.error("Shopify sync failed:", error.response?.data || error.message);
    return res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null
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
  syncImages
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
    let match = await findShopifyMatch(product, skuCandidates, headers);

    if (!match && !createMissing) {
      const message =
        `No Shopify product found for SKU(s): ${skuCandidates.join(", ")}. ` +
        "Creation is disabled to avoid duplicates.";

      await markProductError(product.id, message);
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

    if (!match) {
      if (dryRun) {
        result.action = "would_create";
        return result;
      }

      match = await createShopifyProduct(product, headers);
      result.action = "created";
    } else {
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

    await saveShopifyIds(product.id, match);

    const clearedFlags = {};

    if (product.needs_status_update || product.needs_description_update) {
      await updateProductDetails(product, match.productId, headers);

      if (product.needs_status_update) {
        clearedFlags.needs_status_update = false;
        result.synced.push("status");
      }

      if (product.needs_description_update) {
        clearedFlags.needs_description_update = false;
        result.synced.push("description");
      }
    }

    if (product.needs_price_update || product.needs_compare_at_price_update) {
      await updateVariantPricing(product, match.variantId, headers);
      clearedFlags.needs_price_update = false;
      clearedFlags.needs_compare_at_price_update = false;
      result.synced.push("price");
    }

    if (product.needs_stock_update) {
      const inventoryItemId =
        match.inventoryItemId || (await fetchInventoryItemId(match.variantId, headers));

      await setInventoryLevel(product, inventoryItemId, locationId, headers);
      clearedFlags.needs_stock_update = false;
      result.synced.push("stock");
    }

    if (product.needs_images_update) {
      if (syncImages) {
        await appendMissingImages(product, match.productId, headers);
        clearedFlags.needs_images_update = false;
        result.synced.push("images");
      } else {
        result.skipped.push("images");
      }
    }

    await supabase
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

    return {
      ...result,
      shopify_product_id: String(match.productId),
      shopify_variant_id: String(match.variantId),
      shopify_inventory_item_id: match.inventoryItemId ? String(match.inventoryItemId) : null
    };
  } catch (error) {
    const message = formatShopifyError(error);
    console.error(`Shopify sync error for ${product.item_code}:`, message);
    await markProductError(product.id, message);

    result.action = "error";
    result.errors.push(message);
    return result;
  }
}

async function fetchProductsToSync({ id, itemCode, limit, linkOnly }) {
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
      .order("updated_at", { ascending: true, nullsFirst: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  const { data, error } = await supabase
    .from(PRODUCT_TABLE)
    .select("*")
    .or(
      [
        "needs_stock_update.eq.true",
        "needs_price_update.eq.true",
        "needs_compare_at_price_update.eq.true",
        "needs_status_update.eq.true",
        "needs_description_update.eq.true",
        "needs_images_update.eq.true"
      ].join(",")
    )
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

async function createShopifyProduct(product, headers) {
  const payload = {
    product: {
      title: product.title || product.item_code,
      body_html: product.description_fr || "",
      vendor: "Richmond Interiors",
      product_type: product.product_type || "",
      status: product.status === "archived" ? "archived" : "draft",
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

  await upsertProductMetafields(product, created.id, headers);

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
  await shopify.post(
    "/inventory_levels/set.json",
    {
      location_id: Number(locationId),
      inventory_item_id: Number(inventoryItemId),
      available: Number.parseInt(product.stock_quantity || product.stock || 0, 10)
    },
    { headers }
  );
}

async function appendMissingImages(product, productId, headers) {
  const desiredUrls = Array.isArray(product.images) ? product.images.filter(Boolean) : [];
  if (desiredUrls.length === 0) return;

  const response = await shopify.get(`/products/${productId}/images.json`, { headers });
  const existingImages = response.data.images || [];
  const existingFilenames = new Set(
    existingImages
      .map((image) => filenameFromUrl(image.src || image.alt || ""))
      .filter(Boolean)
  );

  for (const url of desiredUrls) {
    const filename = filenameFromUrl(url);
    if (filename && existingFilenames.has(filename)) continue;

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

    if (filename) existingFilenames.add(filename);
  }
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
  const response = await shopify.get(`/variants/${variantId}.json`, { headers });
  return response.data.variant;
}

async function fetchInventoryItemId(variantId, headers) {
  const variant = await fetchVariant(variantId, headers);
  return variant.inventory_item_id;
}

async function fetchProduct(productId, headers) {
  const response = await shopify.get(`/products/${productId}.json`, { headers });
  return response.data.product;
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
  if (variants.length === 1) return variants[0];

  return null;
}

function buildSkuCandidates(product) {
  return unique([
    product.item_code_new,
    product.item_code
  ].map(cleanString).filter(Boolean));
}

function splitMaterials(value) {
  const text = cleanString(value);
  if (!text) return [];
  return text.split(/[|,/]/).map(cleanString).filter(Boolean);
}

function filenameFromUrl(url) {
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



/*import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01";

export default async function handler(req, res) {
  try {
    const { data: auth } = await supabase.from("shopify_auth").select("access_token").single();
    if (!auth?.access_token) throw new Error("Missing Shopify Token");
    
    const HEADERS = { "X-Shopify-Access-Token": auth.access_token, "Content-Type": "application/json" };

    const { data: products, error: dbError } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(5);

    if (dbError) throw dbError;
    if (!products || products.length === 0) return res.status(200).json({ message: "Rien à synchroniser" });

    const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
    const locationId = locRes.data.locations[0].id;

    for (const p of products) {
      try {
        console.log(`--- Traitement SKU: ${p.item_code} ---`);

        let shopifyId = (p.shopify_product_id && p.shopify_product_id !== "null") ? p.shopify_product_id : null;
        let variantId = (p.variant_id && p.variant_id !== "null") ? p.variant_id : null;

        // 1. RECHERCHE PAR SKU (Sécurité Sidekick)
        if (!shopifyId) {
          const checkSku = await axios.get(
            `https://${SHOP}/admin/api/${API_VERSION}/variants.json?sku=${encodeURIComponent(p.item_code)}`, 
            { headers: HEADERS }
          );
          if (checkSku.data.variants && checkSku.data.variants.length > 0) {
            shopifyId = checkSku.data.variants[0].product_id;
            variantId = checkSku.data.variants[0].id;
          }
        }

        // 2. PRÉPARATION DES METAFIELDS
        const metafields = [
          { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
          { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
          { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
          { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
          { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
          { namespace: "custom", key: "color_richmond", value: p.color || "N/A", type: "single_line_text_field" },
          { namespace: "custom", key: "materials_richmond", value: JSON.stringify(p.materials ? p.materials.split('|') : []), type: "json" }
        ];

        // 3. PAYLOAD GLOBAL
        const payload = {
          product: {
            title: p.title,
            body_html: p.description_fr || "",
            vendor: "Richmond Interiors",
            status: p.status === "archived" ? "archived" : "active",
            images: (p.images || []).map(url => ({ src: url })),
            metafields: metafields, // Injectés ici pour création ET mise à jour
            variants: [{
              sku: p.item_code,
              price: String(p.price || 0),
              inventory_management: "shopify"
            }]
          }
        };

        // 4. EXECUTION (POST ou PUT)
        if (shopifyId) {
          const upRes = await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, payload, { headers: HEADERS });
          variantId = upRes.data.product.variants[0].id;
          console.log(`✅ ${p.item_code} (Update + Metafields)`);
        } else {
          const creRes = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, payload, { headers: HEADERS });
          shopifyId = creRes.data.product.id;
          variantId = creRes.data.product.variants[0].id;
          console.log(`✅ ${p.item_code} (Create + Metafields)`);
          
          // Sync ID immédiate pour éviter doublon si le stock plante
          await supabase.from("products").update({ shopify_product_id: String(shopifyId), variant_id: String(variantId) }).eq("id", p.id);
        }

        // 5. STOCK (Inventory Level)
        const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
        const invId = varRes.data.variant.inventory_item_id;

        await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
          location_id: locationId,
          inventory_item_id: invId,
          available: parseInt(p.stock_quantity || 0)
        }, { headers: HEADERS });

        // 6. FIN
        await supabase.from("products").update({ needs_shopify_update: false, last_shopify_sync: new Date().toISOString() }).eq("id", p.id);

      } catch (err) {
        console.error(`❌ Erreur ${p.item_code}:`, err.response?.data || err.message);
        await supabase.from("products").update({ needs_shopify_update: false }).eq("id", p.id);
      }
    }
    return res.status(200).json({ ok: true, count: products.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}*/
/*
fonctionne mais cinquante produit fait sauté le programme donc il se coupe

import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01";

async function getAccessToken() {
  const { data, error } = await supabase.from("shopify_auth").select("access_token").single();
  if (error || !data?.access_token) throw new Error("❌ No Shopify token");
  return data.access_token;
}

export default async function handler(req, res) {
  try {
    console.log("🚀 START BATCH SYNC (50 PRODUITS)");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(50); 

    if (error) throw error;
    if (!products || products.length === 0) return res.status(200).json({ ok: true, message: "Rien à synchroniser." });

    // On récupère la Location une seule fois
    const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
    const locationId = locRes.data.locations[0].id;

    for (const p of products) {
      try {
        console.log(`--- 🛠 ${p.item_code} ---`);

        const metafields = [
          { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
          { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
          { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
          { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
          { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
          { namespace: "custom", key: "color_richmond", value: p.color || "N/A", type: "single_line_text_field" },
          { namespace: "custom", key: "materials_richmond", value: JSON.stringify(p.materials ? p.materials.split('|') : []), type: "json" }
        ];

        const productPayload = {
          title: p.title,
          body_html: p.description_fr || "",
          vendor: "Richmond Interiors",
          status: p.status === "active" ? "active" : "draft",
          images: (p.images || []).map(url => ({ src: url })),
          metafields: metafields,
          variants: [{
            sku: p.item_code,
            price: String(p.price),
            barcode: p.ean || "",
            inventory_management: "shopify"
          }]
        };

        let shopifyId = p.shopify_product_id;
        let variantId = null;

        // 1. UPDATE OU CREATE (et on capture la réponse pour avoir le variant_id)
        if (shopifyId) {
          try {
            const upRes = await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { product: { id: shopifyId, ...productPayload } }, { headers: HEADERS });
            variantId = upRes.data.product.variants[0].id;
            console.log("✅ Produit mis à jour");
          } catch (e) {
            console.log("⚠️ ID inexistant sur Shopify, passage en création...");
            shopifyId = null;
          }
        }

        if (!shopifyId) {
          const creRes = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, { product: productPayload }, { headers: HEADERS });
          shopifyId = creRes.data.product.id;
          variantId = creRes.data.product.variants[0].id;
          console.log("✅ Produit créé");
        }

        // 2. SYNC STOCK (Sécurisé avec le variantId tout neuf)
        if (variantId) {
          try {
            const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
            const invItemId = varRes.data.variant.inventory_item_id;

            // On s'assure que le suivi est activé
            await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/inventory_items/${invItemId}.json`, { inventory_item: { tracked: true } }, { headers: HEADERS });

            // On injecte la quantité
            await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
              location_id: locationId,
              inventory_item_id: invItemId,
              available: parseInt(p.stock_quantity || 0)
            }, { headers: HEADERS });
            
            console.log(`🔢 Stock réglé sur : ${p.stock_quantity}`);
          } catch (stockErr) {
            console.error(`❌ Erreur Stock ${p.item_code}:`, stockErr.response?.data || stockErr.message);
          }
        }

        // 3. UPDATE SUPABASE
        await supabase.from("products").update({
          shopify_product_id: String(shopifyId),
          variant_id: String(variantId),
          needs_shopify_update: false,
          last_shopify_sync: new Date().toISOString()
        }).eq("id", p.id);

      } catch (prodErr) {
        console.error(`🔴 Erreur Critique sur ${p.item_code}:`, prodErr.response?.data || prodErr.message);
      }
    }

    return res.status(200).json({ ok: true, count: products.length });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
*/
