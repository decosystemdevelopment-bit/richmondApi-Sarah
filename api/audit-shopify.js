// Install as api/audit-shopify.js. Read-only: no sync handler is called.
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  const secret = process.env.AUDIT_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: "AUDIT_SECRET missing" });
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers.authorization || "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const cursor = req.query.page_info;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 8192)) {
    return res.status(400).json({ ok: false, error: "Invalid cursor" });
  }
  let stage = "configuration";
  try {
    const shop = (process.env.SHOPIFY_SHOP || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const version = process.env.SHOPIFY_API_VERSION || "2026-04";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop) ||
        !/^\d{4}-\d{2}$/.test(version) || !key || !process.env.SUPABASE_URL) {
      return res.status(503).json({ ok: false, error: "Check Shopify/Supabase environment variables" });
    }
    stage = "supabase_auth";
    const db = createClient(process.env.SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await db.from("shopify_auth").select("access_token").single();
    if (error || !data?.access_token) {
      return res.status(502).json({ ok: false, stage, error: "Cannot read a unique Shopify token" });
    }
    stage = "shopify_read";
    const response = await axios.get(`https://${shop}/admin/api/${version}/products.json`, {
      headers: { "X-Shopify-Access-Token": data.access_token },
      params: {
        limit: 250,
        ...(cursor ? { page_info: cursor } : {
          fields: "id,title,handle,vendor,status,template_suffix,updated_at,created_at,published_at,body_html,tags,product_type,variants,images"
        })
      },
      timeout: 25000,
      maxRedirects: 0
    });
    if (!Array.isArray(response.data.products)) throw new Error("Invalid catalogue response");
    const products = response.data.products.map(p => ({
      id: String(p.id), title: p.title, handle: p.handle, vendor: p.vendor,
      status: p.status, template_suffix: p.template_suffix, updated_at: p.updated_at,
      created_at: p.created_at, published_at: p.published_at,
      body_html: p.body_html, tags: p.tags, product_type: p.product_type,
      images: (p.images || []).map(i => ({ id: String(i.id), src: i.src, alt: i.alt })),
      variants: (p.variants || []).map(v => ({
        id: String(v.id), sku: v.sku, barcode: v.barcode, title: v.title,
        price: v.price, compare_at_price: v.compare_at_price,
        inventory_item_id: v.inventory_item_id ? String(v.inventory_item_id) : null,
        inventory_quantity: v.inventory_quantity, inventory_management: v.inventory_management
      }))
    }));
    const next = String(response.headers.link || "").split(",")
      .find(part => /rel="next"/.test(part));
    const nextUrl = next?.match(/<([^>]+)>/)?.[1];
    const nextCursor = nextUrl ? new URL(nextUrl).searchParams.get("page_info") : null;
    return res.status(200).json({ ok: true, read_only: true, shop,
      api_version: response.headers["x-shopify-api-version"] || version,
      count: products.length, next_cursor: nextCursor, products });
  } catch (error) {
    // Never return/log Axios configs: they contain the Shopify token.
    const upstreamStatus = error.response?.status || null;
    const retryAfter = error.response?.headers?.["retry-after"];
    if (upstreamStatus === 429) res.setHeader("Retry-After", retryAfter || "3");
    return res.status(upstreamStatus === 429 ? 429 : 502).json({
      ok: false, stage, upstream_status: upstreamStatus,
      error: upstreamStatus === 401 ? "Shopify rejected the token" :
        upstreamStatus === 403 ? "Shopify access denied: check permissions" : "Read failed"
    });
  }
}
