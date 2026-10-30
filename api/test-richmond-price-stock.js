// Install at api/test-richmond-price-stock.js. Simulation ONLY. No write calls.
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';

export function parseNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const raw = String(value).trim();
  if (!/^-?\d+(?:[.,]\d+)?$/.test(raw)) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function calculatePrice(row) {
  const base = parseNumber(row.price);
  const percent = parseNumber(row.discountPercentage) ?? 0;
  const provided = parseNumber(row.discountPrice);
  if (!(base > 0) || percent < 0 || percent > 100) throw Error('Invalid supplier pricing');
  if (String(row.priceCurrencySymbol || '').trim() !== '€') throw Error('Currency must be EUR');
  const discount = provided || (percent > 0 ? base * (1 - percent / 100) : null);
  const sale = discount > 0 && discount < base;
  return { coefficient: 2.3, rounding: 'nearest_euro', supplier_price: base,
    price: Math.round((sale ? discount : base) * 2.3),
    compare_at_price: sale ? Math.round(base * 2.3) : null };
}

export function calculateStock(row) {
  const raw = String(row.onlineAvailabilityText || row.lastAvailableStock || '').trim();
  const match = raw.match(/^(<|>)?\s*(\d+)$/);
  if (!match) return { valid: false, raw, quantity: null };
  return { valid: true, raw, quantity: Math.max(0, Number(match[2]) - (match[1] === '<' ? 1 : 0)) };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok:false,error:'Simulation: GET only' });
  const secret=process.env.AUDIT_SECRET;
  if (!secret) return res.status(503).json({ok:false,error:'AUDIT_SECRET missing'});
  const expected=Buffer.from(`Bearer ${secret}`), actual=Buffer.from(req.headers.authorization||'');
  if(expected.length!==actual.length || !timingSafeEqual(expected,actual)) {
    return res.status(401).json({ok:false,error:'Unauthorized'});
  }
  const code=req.query.item_code;
  if(typeof code!=='string'||!/^\d{6}$/.test(code))return res.status(400).json({ok:false,error:'Six-digit item_code required'});
  let stage='configuration';
  try {
    const shop=(process.env.SHOPIFY_SHOP||'').replace(/^https?:\/\//,'').replace(/\/$/,'');
    const version=process.env.SHOPIFY_API_VERSION||'2026-04';
    const key=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_KEY;
    if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)||!/^\d{4}-\d{2}$/.test(version)||!key||!process.env.SUPABASE_URL||!process.env.RICHMOND_AUTH)throw Error('Missing configuration');
    const db=createClient(process.env.SUPABASE_URL,key,{auth:{persistSession:false,autoRefreshToken:false}});
    stage='supabase_read';
    const [auth,record]=await Promise.all([
      db.from('shopify_auth').select('access_token').single(),
      db.from(process.env.SUPABASE_PRODUCT_TABLE||'products_richmond')
        .select('item_code,item_code_new,shopify_product_id,shopify_variant_id').eq('item_code',code).single()
    ]);
    if(auth.error||record.error||!auth.data?.access_token)throw Error('Cannot read token or unique product');
    const row=record.data;
    if(!/^\d+$/.test(row.shopify_product_id||'')||!/^\d+$/.test(row.shopify_variant_id||'')) {
      return res.status(409).json({ok:false,error:'Validated Shopify IDs required',item_code:code});
    }
    stage='richmond_read';
    const supplierAuth=process.env.RICHMOND_AUTH.replace(/^\/+|\/+$/g,'');
    const supplier={};
    // Sequential reads: keep load predictable; the route still reads only three datasets.
    for(const dataset of ['details','pricing','stocklevels']) {
      const response=await axios.get(`https://www.richmondinteriors.nl/api/v1/products/${dataset}/${supplierAuth}`,{timeout:12000,maxRedirects:0});
      if(!Array.isArray(response.data)||!response.data.length)throw Error('Invalid supplier dataset');
      const matches=response.data.filter(p=>String(p.itemCodeNew||p.itemCode||'').trim()===code);
      if(matches.length!==1)return res.status(409).json({ok:false,error:'Supplier reference absent or ambiguous',dataset,item_code:code});
      supplier[dataset]=matches[0];
    }
    const supplierStatus=String(supplier.details['Product Status']||'').trim();
    if(!['Actief','Uitlopend'].includes(supplierStatus))return res.status(200).json({ok:true,read_only:true,item_code:code,skipped:true,reason:'Supplier product not active or end-of-series',supplier_status:supplierStatus});
    const desiredPrice=calculatePrice(supplier.pricing),desiredStock=calculateStock(supplier.stocklevels);
    stage='shopify_read';
    const api=axios.create({baseURL:`https://${shop}/admin/api/${version}`,timeout:10000,maxRedirects:0,
      headers:{'X-Shopify-Access-Token':auth.data.access_token}});
    const product=(await api.get(`/products/${row.shopify_product_id}.json`)).data.product;
    if(product.vendor!=='Richmond Interiors'||product.status!=='active')return res.status(200).json({ok:true,read_only:true,item_code:code,skipped:true,reason:'Preserve non-active or non-Richmond Shopify product',shopify_status:product.status});
    const variant=product.variants.find(v=>String(v.id)===row.shopify_variant_id);
    if(!variant||![row.item_code,row.item_code_new].includes(String(variant.sku||'').trim()))throw Error('Stored variant/SKU mismatch');
    await new Promise(resolve=>setTimeout(resolve,650));
    const levels=(await api.get('/inventory_levels.json',{params:{inventory_item_ids:String(variant.inventory_item_id),limit:250}})).data.inventory_levels;
    await new Promise(resolve=>setTimeout(resolve,650));
    const locations=(await api.get('/locations.json')).data.locations;
    if(!Array.isArray(levels)||!Array.isArray(locations))throw Error('Invalid location response');
    const configuredLocation=process.env.SHOPIFY_LOCATION_ID||null;
    const target=configuredLocation?levels.find(l=>String(l.location_id)===configuredLocation):null;
    return res.status(200).json({ok:true,read_only:true,item_code:code,title:product.title,
      supplier_status:supplierStatus,shopify_status:product.status,
      price:{current:variant.price,current_compare_at_price:variant.compare_at_price,desired:desiredPrice,
        would_change:Math.abs(Number(variant.price)-desiredPrice.price)>.009 || parseNumber(variant.compare_at_price)!==desiredPrice.compare_at_price},
      stock:{desired:desiredStock,inventory_management:variant.inventory_management,
        configured_location_id:configuredLocation,
        locations:levels.map(l=>({location_id:String(l.location_id),name:locations.find(x=>String(x.id)===String(l.location_id))?.name||null,available:l.available})),
        current_at_configured_location:target?.available??null,
        would_change:target&&desiredStock.valid&&variant.inventory_management==='shopify'?target.available!==desiredStock.quantity:null},
      preserved:['title','description','images','status','metafields','other_variants']});
  }catch(error){
    // Never log upstream errors/configs: supplier URLs and headers contain secrets.
    return res.status(502).json({ok:false,read_only:true,stage,upstream_status:error.response?.status||null,error:'Simulation failed; no data modified'});
  }
}
