/**
 * Richmond -> Supabase sync
 *
 * This endpoint only syncs Richmond data into Supabase.
 * Shopify is not called here.
 *
 * Run by batch to avoid Vercel timeouts:
 *   /api/sync-richmond?offset=0&limit=100
 *
 * The response returns nextOffset when another batch is available.
 */

import axios from "axios";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_KEY = requireAnyEnv(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"]);
const RICHMOND_AUTH = requireEnv("RICHMOND_AUTH").replace(/^\/+|\/+$/g, "");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BASE_URL = "https://www.richmondinteriors.nl/api/v1/products";
const PRODUCT_TABLE = process.env.SUPABASE_PRODUCT_TABLE || "products_richmond";
const PRICE_COEFF = parseFloat(process.env.PRICE_COEFF || "2.3");
const DEFAULT_LIMIT = parseInt(process.env.RICHMOND_SYNC_LIMIT || "100", 10);

const richmondApi = {
  details: `${BASE_URL}/details/${RICHMOND_AUTH}`,
  pricing: `${BASE_URL}/pricing/${RICHMOND_AUTH}`,
  stock: `${BASE_URL}/stocklevels/${RICHMOND_AUTH}`,
  descriptions: `${BASE_URL}/descriptions/${RICHMOND_AUTH}`
};

const http = axios.create({
  timeout: parseInt(process.env.RICHMOND_TIMEOUT_MS || "45000", 10)
});

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const startedAt = Date.now();
    const now = new Date().toISOString();

    const offset = readIntQuery(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = readIntQuery(req.query.limit, DEFAULT_LIMIT, 1, 500);
    const runFullSync = readBooleanQuery(req.query.full, false);
    const archiveMissing = readBooleanQuery(req.query.archiveMissing, offset === 0);

    const [detailsRes, pricingRes, stockRes, descriptionsRes] = await Promise.all([
      http.get(richmondApi.details),
      http.get(richmondApi.pricing),
      http.get(richmondApi.stock),
      http.get(richmondApi.descriptions)
    ]);

    const detailsRows = asArray(detailsRes.data, "details").filter(getPrimaryCode);
    const pricingMap = buildRichmondMap(asArray(pricingRes.data, "pricing"));
    const stockMap = buildRichmondMap(asArray(stockRes.data, "stocklevels"));
    const descriptionsMap = buildRichmondMap(asArray(descriptionsRes.data, "descriptions"));

    const rowsToProcess = runFullSync
      ? detailsRows
      : detailsRows.slice(offset, offset + limit);

    const codes = rowsToProcess.map(getPrimaryCode).filter(Boolean);
    const existingRows = await fetchExistingProducts(codes);
    const existingMap = new Map(existingRows.map((row) => [row.item_code, row]));

    const upserts = [];
    let created = 0;
    let changed = 0;

    for (const details of rowsToProcess) {
      const code = getPrimaryCode(details);
      const pricing = pricingMap.get(code) || {};
      const stock = stockMap.get(code) || {};
      const descriptions = descriptionsMap.get(code) || {};
      const existing = existingMap.get(code);

      const product = normalizeProduct(details, pricing, stock, descriptions);
      const hashes = buildHashes(product);

      const isNew = !existing;
      const detailsChanged = isNew || existing.richmond_details_hash !== hashes.details;
      const pricingChanged = isNew || existing.richmond_pricing_hash !== hashes.pricing;
      const stockChanged = isNew || existing.richmond_stock_hash !== hashes.stock;
      const descriptionsChanged =
        isNew || existing.richmond_descriptions_hash !== hashes.descriptions;

      const statusChanged = isNew || existing.status !== product.status;
      const imagesChanged = isNew || generateHash(existing.images || []) !== generateHash(product.images);
      const productContentChanged = detailsChanged || descriptionsChanged;
      const anyChanged = detailsChanged || pricingChanged || stockChanged || descriptionsChanged;

      if (isNew) created += 1;
      if (anyChanged) changed += 1;

      upserts.push({
        item_code: code,
        item_code_new: product.item_code_new,
        ean: product.ean,
        title: product.title,
        product_type: product.product_type,
        stock: product.stock_quantity,
        stock_quantity: product.stock_quantity,
        price: product.price,
        compare_at_price: product.compare_at_price,
        richmond_price: product.richmond_price,
        richmond_retail_price: product.richmond_retail_price,
        richmond_discount_retail_price: product.richmond_discount_retail_price,
        richmond_discount_percentage: product.richmond_discount_percentage,
        richmond_discount_description: product.richmond_discount_description,
        is_on_sale: product.is_on_sale,
        description_fr: product.description_fr,
        description_en: product.description_en,
        images: product.images,
        width: product.width,
        height: product.height,
        depth: product.depth,
        weight: product.weight,
        materials: product.materials,
        color: product.color,
        volume: product.volume,
        extra_info: product.extra_info,
        status: product.status,
        available_from: product.available_from,
        specs: product.specs,
        raw_data: product.raw_data,
        stock_indicator: product.stock_indicator,
        stock_bucket: product.stock_bucket,
        online_availability_text: product.online_availability_text,
        online_next_availability_text: product.online_next_availability_text,
        richmond_hash: hashes.global,
        richmond_details_hash: hashes.details,
        richmond_pricing_hash: hashes.pricing,
        richmond_stock_hash: hashes.stock,
        richmond_descriptions_hash: hashes.descriptions,
        needs_stock_update: keepFlag(existing, "needs_stock_update", stockChanged),
        needs_price_update: keepFlag(existing, "needs_price_update", pricingChanged),
        needs_compare_at_price_update: keepFlag(
          existing,
          "needs_compare_at_price_update",
          pricingChanged
        ),
        needs_status_update: keepFlag(existing, "needs_status_update", statusChanged),
        needs_description_update: keepFlag(
          existing,
          "needs_description_update",
          productContentChanged
        ),
        needs_images_update: keepFlag(existing, "needs_images_update", imagesChanged),
        last_richmond_sync: now,
        ...(anyChanged ? { updated_at: now } : {})
      });
    }

    if (upserts.length > 0) {
      const { error } = await supabase.from(PRODUCT_TABLE).upsert(upserts, {
        onConflict: "item_code"
      });

      if (error) throw error;
    }

    const archived = archiveMissing
      ? await archiveMissingProducts(detailsRows.map(getPrimaryCode), now)
      : 0;

    const nextOffset = runFullSync || offset + limit >= detailsRows.length
      ? null
      : offset + limit;

    return res.status(200).json({
      ok: true,
      totalRichmondProducts: detailsRows.length,
      processed: upserts.length,
      created,
      changed,
      archived,
      offset: runFullSync ? 0 : offset,
      limit: runFullSync ? detailsRows.length : limit,
      nextOffset,
      done: nextOffset === null,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    console.error("Richmond sync failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}

function normalizeProduct(details, pricing, stock, descriptions) {
  const pricingData = normalizePricing(pricing);
  const stockData = normalizeStock(details, stock);
  const images = buildImages(details);
  const itemCodeNew = cleanString(details.itemCodeNew) || getPrimaryCode(details);

  const descriptionFr = cleanText(
    descriptions.longDescriptionFR ||
      descriptions.shortDescriptionFR ||
      details.description2 ||
      ""
  );

  const descriptionEn = cleanText(
    descriptions.longDescriptionEN ||
      descriptions.shortDescriptionEN ||
      details.description3 ||
      ""
  );

  const product = {
    item_code_new: itemCodeNew,
    ean: cleanString(details.eanCode),
    title: cleanString(details.description2 || details.description3 || details.description || itemCodeNew),
    product_type: cleanString(details["Product type"]),
    description_fr: descriptionFr,
    description_en: descriptionEn,
    images,
    status: mapStatus(details),
    width: parseRichmondNumber(details["Width (cm)"]),
    height: parseRichmondNumber(details["Height (cm)"]),
    depth: parseRichmondNumber(details["Depth (cm)"]),
    weight: parseRichmondNumber(details["Bruto Weight"]),
    materials: cleanString(details.Materiaal),
    color: joinParts([details.Exterior, details.Interior, details.Finishing]),
    volume: parseRichmondNumber(details.Volume),
    extra_info: cleanText(details["Extra Informatie"]),
    available_from: cleanString(stock["Available from Week"] || details["Available from Week"]),
    specs: buildSpecs(details, pricing, stock),
    raw_data: {
      details,
      pricing,
      stock,
      descriptions
    },
    ...pricingData,
    ...stockData
  };

  return product;
}

function normalizePricing(pricing) {
  const supplierPrice = parseRichmondNumber(pricing.price) || 0;
  const discountPercentage = parseRichmondNumber(pricing.discountPercentage) || 0;
  const providedDiscountPrice = parseRichmondNumber(pricing.discountPrice);
  const computedDiscountPrice =
    discountPercentage > 0 ? supplierPrice * (1 - discountPercentage / 100) : null;

  const supplierDiscountPrice = providedDiscountPrice || computedDiscountPrice;
  const hasDiscount =
    supplierPrice > 0 &&
    supplierDiscountPrice !== null &&
    supplierDiscountPrice > 0 &&
    supplierDiscountPrice < supplierPrice;

  const regularShopifyPrice = roundMoney(supplierPrice * PRICE_COEFF);
  const discountShopifyPrice = hasDiscount
    ? roundMoney(supplierDiscountPrice * PRICE_COEFF)
    : null;

  return {
    price: hasDiscount ? discountShopifyPrice : regularShopifyPrice,
    compare_at_price: hasDiscount ? regularShopifyPrice : null,
    richmond_price: supplierPrice,
    richmond_retail_price: parseRichmondNumber(pricing.retailPrice),
    richmond_discount_retail_price: parseRichmondNumber(pricing.discountRetailprice),
    richmond_discount_percentage: discountPercentage,
    richmond_discount_description: cleanString(pricing.discountDescription),
    is_on_sale: hasDiscount
  };
}

function normalizeStock(details, stock) {
  const onlineAvailability = cleanString(stock.onlineAvailabilityText);
  const stockBucket = cleanString(stock.lastAvailableStock || details.lastAvailableStock);
  const stockQuantity = parseStockQuantity(onlineAvailability || stockBucket);

  return {
    stock_quantity: stockQuantity,
    stock_indicator: parseInteger(stock.StockIndicator || details.StockIndicator),
    stock_bucket: stockBucket,
    online_availability_text: onlineAvailability,
    online_next_availability_text: cleanString(stock.onlineNextAvailabilityText)
  };
}

function buildHashes(product) {
  const detailsHash = generateHash({
    item_code_new: product.item_code_new,
    ean: product.ean,
    title: product.title,
    product_type: product.product_type,
    status: product.status,
    images: product.images,
    width: product.width,
    height: product.height,
    depth: product.depth,
    weight: product.weight,
    materials: product.materials,
    color: product.color,
    volume: product.volume,
    extra_info: product.extra_info,
    available_from: product.available_from,
    specs: product.specs
  });

  const pricingHash = generateHash({
    price: product.price,
    compare_at_price: product.compare_at_price,
    richmond_price: product.richmond_price,
    richmond_retail_price: product.richmond_retail_price,
    richmond_discount_retail_price: product.richmond_discount_retail_price,
    richmond_discount_percentage: product.richmond_discount_percentage,
    richmond_discount_description: product.richmond_discount_description,
    is_on_sale: product.is_on_sale
  });

  const stockHash = generateHash({
    stock_quantity: product.stock_quantity,
    stock_indicator: product.stock_indicator,
    stock_bucket: product.stock_bucket,
    online_availability_text: product.online_availability_text,
    online_next_availability_text: product.online_next_availability_text,
    available_from: product.available_from
  });

  const descriptionsHash = generateHash({
    description_fr: product.description_fr,
    description_en: product.description_en
  });

  return {
    details: detailsHash,
    pricing: pricingHash,
    stock: stockHash,
    descriptions: descriptionsHash,
    global: generateHash({
      detailsHash,
      pricingHash,
      stockHash,
      descriptionsHash
    })
  };
}

async function fetchExistingProducts(codes) {
  if (codes.length === 0) return [];

  const { data, error } = await supabase
    .from(PRODUCT_TABLE)
    .select(`
      item_code,
      item_code_new,
      shopify_product_id,
      status,
      images,
      richmond_hash,
      richmond_details_hash,
      richmond_pricing_hash,
      richmond_stock_hash,
      richmond_descriptions_hash,
      needs_stock_update,
      needs_price_update,
      needs_compare_at_price_update,
      needs_status_update,
      needs_description_update,
      needs_images_update
    `)
    .in("item_code", codes);

  if (error) throw error;
  return data || [];
}

async function archiveMissingProducts(currentCodes, now) {
  const currentCodeSet = new Set(currentCodes);

  const { data, error } = await supabase
    .from(PRODUCT_TABLE)
    .select("item_code, status")
    .not("item_code", "is", null);

  if (error) throw error;

  const codesToArchive = (data || [])
    .filter((row) => row.item_code && !currentCodeSet.has(row.item_code))
    .filter((row) => row.status !== "archived")
    .map((row) => row.item_code);

  for (const chunk of chunkArray(codesToArchive, 100)) {
    const { error: updateError } = await supabase
      .from(PRODUCT_TABLE)
      .update({
        status: "archived",
        needs_status_update: true,
        last_richmond_sync: now,
        updated_at: now
      })
      .in("item_code", chunk);

    if (updateError) throw updateError;
  }

  return codesToArchive.length;
}

function buildImages(details) {
  const imageGroups = [
    ["Product Images Location", "Product Images"],
    ["Product Settings Location", "Product Setting Images"],
    ["Product Dimensions Location", "Product Dimension Images"]
  ];

  const urls = [];

  for (const [baseKey, filesKey] of imageGroups) {
    const baseUrl = cleanString(details[baseKey]);
    const files = cleanString(details[filesKey]);

    if (!baseUrl || !files) continue;

    for (const file of files.split(",").map(cleanString).filter(Boolean)) {
      urls.push(`${baseUrl}${file}`);
    }
  }

  return [...new Set(urls)];
}

function buildSpecs(details, pricing, stock) {
  return compactObject({
    richmond_item_code_legacy: cleanString(details.itemCode),
    price_list_id: cleanString(pricing.priceListId),
    collection: cleanString(details.Collection || stock.Collection),
    product_status_raw: cleanString(details["Product Status"]),
    is_new: parseRichmondBoolean(details["Product Status New"]),
    is_fire_retardant: parseRichmondBoolean(details["Product Status Fire Retardant"]),
    is_stock_article: parseRichmondBoolean(details["Product Status Stock"]),
    is_customized: parseRichmondBoolean(details["Product Status Customized"]),
    sale: parseRichmondBoolean(details.Sale),
    sales_unit: cleanString(details["Sales Unit"]),
    purchase_package_size: parseRichmondNumber(details.purchasePackageSize),
    vat_included: cleanString(details.vatIncluded),
    vat_percentage: parseRichmondNumber(details.vatPercentage),
    colli: parseRichmondNumber(details.Colli),
    exterior: cleanString(details.Exterior),
    interior: cleanString(details.Interior),
    finishing: cleanString(details.Finishing),
    hardware: cleanString(details.Hardware)
  });
}

function buildRichmondMap(rows) {
  const map = new Map();

  for (const row of rows) {
    const itemCodeNew = cleanString(row.itemCodeNew);
    const itemCode = cleanString(row.itemCode);

    if (itemCodeNew) map.set(itemCodeNew, row);
    if (itemCode && !map.has(itemCode)) map.set(itemCode, row);
  }

  return map;
}

function getPrimaryCode(row) {
  return cleanString(row?.itemCodeNew || row?.itemCode);
}

function mapStatus(details) {
  const raw = cleanString(details["Product Status"]).toLowerCase();

  if (
    raw.includes("stopgezet") ||
    raw.includes("discontinued") ||
    raw.includes("arrêté") ||
    raw.includes("arrete")
  ) {
    return "archived";
  }

  return "active";
}

function keepFlag(existing, key, changed) {
  return Boolean(existing?.[key]) || Boolean(changed);
}

function generateHash(value) {
  return crypto
    .createHash("md5")
    .update(JSON.stringify(sortForHash(value)))
    .digest("hex");
}

function sortForHash(value) {
  if (Array.isArray(value)) {
    return value.map(sortForHash);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((sorted, key) => {
        if (value[key] !== undefined) {
          sorted[key] = sortForHash(value[key]);
        }
        return sorted;
      }, {});
  }

  return value;
}

function parseRichmondNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const raw = cleanString(value);
  if (!raw || raw === "-") return null;

  let text = raw.replace(/\s/g, "").replace(/[^\d.,-]/g, "");
  if (!text) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma > lastDot) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(/,/g, "");
  }

  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value) {
  const number = parseRichmondNumber(value);
  return number === null ? null : Math.trunc(number);
}

function parseStockQuantity(value) {
  const text = cleanString(value);
  if (!text || text === "-") return 0;

  const number = parseInteger(text);
  if (number === null) return 0;

  if (text.startsWith("<")) {
    return Math.max(number - 1, 0);
  }

  return number;
}

function parseRichmondBoolean(value) {
  const text = cleanString(value).toLowerCase();
  return ["true", "1", "yes", "ja", "oui"].includes(text);
}

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function joinParts(parts) {
  return parts.map(cleanString).filter(Boolean).join(" / ");
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (value === "") return false;
      return true;
    })
  );
}

function roundMoney(value) {
  return Number((value || 0).toFixed(2));
}

function asArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`Richmond endpoint "${name}" did not return an array`);
  }
  return value;
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

function chunkArray(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
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



/**
 * ============================================================
 * Richmond → Supabase Sync
 * ============================================================
 *
 * Objectif :
 * Synchroniser les données produits depuis l'API Richmond
 * vers la base de données Supabase, en détectant uniquement
 * les changements (diff-based sync).
 *
 * ------------------------------------------------------------
 * Fonctionnement global :
 *
 * 1. Récupère les données Richmond via 4 endpoints :
 *    - details (infos produit)
 *    - pricing (prix)
 *    - stock (stock)
 *    - descriptions (contenu)
 *
 * 2. Recompose un objet produit "normalisé" pour chaque item :
 *    → titre, prix, stock, description, images
 *
 * 3. Génère un hash (MD5) basé sur ces données :
 *    → représente l'état du produit à un instant T
 *
 * 4. Compare ce hash avec celui stocké dans Supabase :
 *    - différent → produit modifié
 *    - identique → aucun changement
 *
 * 5. Met à jour la base Supabase avec :
 *    - les nouvelles données
 *    - le nouveau hash
 *    - un flag `needs_shopify_update` si changement détecté
 *
 * ------------------------------------------------------------
 * Pagination :
 * Le script traite les produits par batch (100) via `offset`
 * pour éviter les timeouts Vercel.
 *
 * Exemple :
 * /api/sync-richmond?offset=0
 * /api/sync-richmond?offset=100
 *
 * ------------------------------------------------------------
 * Champs clés :
 *
 * - richmond_hash :
 *   Empreinte du produit → permet de détecter les changements
 *
 * - needs_shopify_update :
 *   Flag utilisé pour déclencher la sync vers Shopify
 *
 * - last_richmond_sync :
 *   Date du dernier passage du script sur ce produit
 *
 * ------------------------------------------------------------
 * Résultat :
 *
 * Ce script alimente Supabase comme source de vérité
 * et prépare uniquement les produits modifiés pour Shopify.
 *
 * Shopify n'est PAS appelé ici.
 *
 * ============================================================
 */




/*


ancien fichier qui marche
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BASE = "https://www.richmondinteriors.nl/api/v1/products";
const AUTH = process.env.RICHMOND_AUTH;

const API = {
  details: `${BASE}/details/${AUTH}`,
  pricing: `${BASE}/pricing/${AUTH}`,
  stock: `${BASE}/stocklevels/${AUTH}`,
  desc: `${BASE}/descriptions/${AUTH}`
};

const COEFF = parseFloat(process.env.PRICE_COEFF || "2.3");

function generateHash(data) {
  return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
}

function parsePrice(v) {
  if (!v) return 0;
  return parseFloat(
    v
      .replace(/\./g, "")   // enlève milliers
      .replace(",", ".")    // virgule → point
  );
}

function parseStock(v) {
  const n = parseInt(String(v || "").replace(/[^\d]/g, ""));
  return isNaN(n) ? 0 : n;
}

function buildImages(p) {
  const base = p["Product Images Location"] || "";
  return (p["Product Images"] || "")
    .split(",")
    .map(i => i.trim())
    .filter(Boolean)
    .map(i => base + i)
    .sort();
}

function mapStatus(p) {
  const raw = (p["Product Status"] || "").toLowerCase();
  return raw.includes("discontinued") ? "archived" : "active";
}

export default async function handler(req, res) {
  try {
    console.log("🔄 Richmond sync...");

    const [productsRes, pricingRes, stockRes, descRes] =
      await Promise.all([
        axios.get(API.details),
        axios.get(API.pricing),
        axios.get(API.stock),
        axios.get(API.desc)
      ]);

    const allProducts = productsRes.data;

    const pricingMap = Object.fromEntries(
      pricingRes.data.map(p => [p.itemCodeNew, p])
    );

    const stockMap = Object.fromEntries(
      stockRes.data.map(s => [s.itemCodeNew, s])
    );

    const descMap = Object.fromEntries(
      descRes.data.map(d => [d.itemCodeNew, d])
    );

    const limit = 100;
    let totalProcessed = 0;

    for (let offset = 0; offset < allProducts.length; offset += limit) {
      const batch = allProducts.slice(offset, offset + limit);
      const codes = batch.map(p => p.itemCodeNew);

      const { data: existingRows } = await supabase
        .from("products")
        .select("item_code, richmond_hash")
        .in("item_code", codes);

      const existingMap = Object.fromEntries(
        (existingRows || []).map(e => [e.item_code, e])
      );

      const upserts = [];

      for (const p of batch) {
        const code = p.itemCodeNew;

        const basePrice = parsePrice(pricingMap[code]?.price);//prix fournisseur
        const finalPrice = Number((basePrice * COEFF).toFixed(2));

        const productData = {
          title: p.description2 || p.description3 || "",
          price: finalPrice,
          richmond_price: basePrice,
          stock: parseStock(stockMap[code]?.onlineAvailabilityText),
          description: (descMap[code]?.longDescriptionFR || "").trim(),
          images: buildImages(p),
          status: mapStatus(p)
        };

        const hash = generateHash(productData);
        const existing = existingMap[code];

        const hasChanged = !existing || existing.richmond_hash !== hash;
        if (offset === 0 && upserts.length < 5) {
          console.log({
            code,
            api_price: pricingMap[code]?.price,
            parsed: basePrice,
            final: finalPrice
          });
        }
        upserts.push({
          item_code: code,
          title: productData.title,
          price: productData.price,
          richmond_price: productData.richmond_price,
          stock_quantity: productData.stock,
          description_fr: productData.description,
          images: productData.images,
          status: productData.status,
          richmond_hash: hash,
          needs_shopify_update: hasChanged,
          last_richmond_sync: new Date().toISOString()
        });
      }

      if (upserts.length > 0) {
        await supabase.from("products").upsert(upserts, {
          onConflict: "item_code"
        });
      }

      totalProcessed += upserts.length;
      console.log(`Batch processed: ${upserts.length}`);
    }

    // 🔥 Gestion produits supprimés
    const allCodes = allProducts.map(p => p.itemCodeNew);

    const { data: dbProducts } = await supabase
      .from("products")
      .select("item_code");

    const deleted = (dbProducts || []).filter(
      p => !allCodes.includes(p.item_code)
    );

    for (const p of deleted) {
      await supabase
        .from("products")
        .update({
          status: "archived",
          needs_shopify_update: true
        })
        .eq("item_code", p.item_code);
    }

    console.log(`🗑️ Archived ${deleted.length}`);
    console.log(`✅ Total processed: ${totalProcessed}`);

    return res.status(200).json({
      ok: true,
      processed: totalProcessed
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}*/
