import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import refresh from './sync-richmond.js';
import sync from './sync-shopify.js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
const table = process.env.SUPABASE_PRODUCT_TABLE || 'products_richmond';
const jobs = ['catalogue','supplier-stock','stock','prices','information','images','publish'];
const phases = { prices:'priority', information:'information', images:'images' };
const flags = { prices:['needs_price_update','needs_compare_at_price_update'], information:['needs_description_update','needs_status_update'], images:['needs_images_update'],stock:['needs_stock_update'] };
const auth = (a,b) => {const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const check = ({data,error}) => {if(error)throw Error('Supabase operation failed');return data;};
async function all(name, columns='*') {
  const rows=[];for(let offset=0;;offset+=500){let q=db.from(name).select(columns).order(name===table?'item_code':name==='richmond_publication_queue'?'item_code':'job');if(name==='richmond_cron_tasks')q=q.order('item_code');const batch=check(await q.range(offset,offset+499));rows.push(...batch);if(batch.length<500)return rows;}
}
async function invoke(handler, query, body, deadline) {
  let status=200,result;
  await handler({richmondInternalCron:true,richmondDeadline:deadline,method:body?'POST':'GET',query,body,headers:{authorization:`Bearer ${process.env.CRON_SECRET}`}},
    {setHeader(){},status(n){status=n;return this;},json(x){result=x;return this;}});
  if(status>=400||result?.ok===false)throw Error(`Handler failed: HTTP ${status}`);
  return result;
}
async function record(job,code,result,problem=false) {
  const current=check(await db.from('richmond_cron_tasks').select('attempts').eq('job',job).eq('item_code',code).maybeSingle());
  const attempts=problem?(current?.attempts||0)+1:0;
  const delay=problem?Math.min(24*60,5*2**Math.min(attempts,9)):result.action==='skipped'?(/^(Waiting for|New inventory connected|Supplier stock older)/.test(result.reason||'')?5:24*60):0;
  check(await db.from('richmond_cron_tasks').upsert({job,item_code:code,attempts,next_at:new Date(Date.now()+delay*60000).toISOString(),last_result:result},{onConflict:'job,item_code'}));
}
function eligible(rows,job,tasks) {
  const states=new Map(tasks.filter(t=>t.job===job).map(t=>[t.item_code,t]));
  return rows.filter(r=>!states.has(r.item_code)||Date.parse(states.get(r.item_code).next_at)<=Date.now())
    .sort((a,b)=>(Date.parse(states.get(a.item_code)?.next_at||'1970-01-01')-Date.parse(states.get(b.item_code)?.next_at||'1970-01-01'))||String(a.item_code).localeCompare(String(b.item_code)));
}
function selectPending(rows,job,tasks,queue,limit) {
  const ready=eligible(rows,job,tasks);
  const authorised=new Map(queue.filter(q=>q.status==='pending').map(q=>[q.item_code,String(q.product_id)]));
  const isNew=r=>!r.shopify_product_id||authorised.get(r.item_code)===String(r.shopify_product_id);
  const priority=ready.filter(isNew),regular=ready.filter(r=>!isNew(r));
  // Reserve capacity for existing products too: a continuous stream of new products
  // must not starve stock/price maintenance of the current catalogue.
  const first=priority.slice(0,Math.max(1,Math.floor(limit*0.8)));
  const normal=regular.slice(0,limit-first.length);
  return [...first,...normal,...priority.slice(first.length,first.length+limit-first.length-normal.length)];
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'GET only'});
  if(!process.env.CRON_SECRET||!auth(req.headers.authorization,`Bearer ${process.env.CRON_SECRET}`))return res.status(401).json({ok:false,error:'Unauthorized'});
  if(req.query.job==='preflight')return await preflight(res);
  if(process.env.RICHMOND_CRON_ENABLED!=='true')return res.status(503).json({ok:false,error:'Crons disabled'});
  const job=req.query.job;if(!jobs.includes(job))return res.status(400).json({ok:false,error:'Unknown job'});
  const id=randomUUID(),started=Date.now(),summary={processed:0,errors:0,results:[]};let locked=false;
  try{
    locked=check(await db.rpc('richmond_acquire_lock',{lock_owner:id}));
    if(!locked)return res.status(200).json({ok:true,skipped:'Another pipeline task is running'});
    check(await db.from('richmond_cron_runs').insert({id,job}));
    if(job==='catalogue'||job==='supplier-stock'){
      summary.refresh=await invoke(refresh,job==='catalogue'?{full:'true'}:{stockOnly:'true'});
      if(job==='catalogue'){
        const source=new Set(summary.refresh.item_codes||[]);
        if(!source.size)throw Error('Supplier catalogue returned no reference list');
        summary.absent_from_supplier=(await all(table,'item_code,shopify_product_id')).filter(r=>!source.has(r.item_code)).map(r=>({item_code:r.item_code,product_id:r.shopify_product_id}));
      }
    }else{
      const catalogue=check(await db.from('richmond_cron_runs').select('started_at,summary').eq('job','catalogue').eq('status','success').order('started_at',{ascending:false}).limit(1).maybeSingle());
      const sourceCodes=catalogue?.summary?.refresh?.item_codes;
      if(!Array.isArray(sourceCodes)||!sourceCodes.length||Date.now()-Date.parse(catalogue.started_at)>18*3600000)throw Error('Supplier catalogue missing or stale; refresh catalogue before Shopify writes');
      const source=new Set(sourceCodes);
      const storedRows=await all(table,'item_code,shopify_product_id,shopify_variant_id,needs_stock_update,needs_price_update,needs_compare_at_price_update,needs_description_update,needs_status_update,needs_images_update');
      const rows=storedRows.filter(r=>source.has(r.item_code));
      summary.absent_references_preserved=storedRows.length-rows.length;
      const tasks=await all('richmond_cron_tasks','job,item_code,attempts,next_at');
      const queue=await all('richmond_publication_queue','item_code,product_id,status');
      if(job==='publish'){
        if(process.env.RICHMOND_AUTO_PUBLISH!=='true')throw Error('Automatic publication disabled');
        for(const entry of eligible(queue.filter(q=>q.status==='pending'&&source.has(q.item_code)),'publish',tasks).slice(0,5)){
          if(Date.now()-started>180000)break;
          await work(entry.item_code,async()=>{
            const row=check(await db.from(table).select('*').eq('item_code',entry.item_code).maybeSingle());
            return publish(entry,row);
          },job,summary);
        }
      }else if(job==='stock'){
        const pending=selectPending(rows.filter(r=>r.needs_stock_update&&r.shopify_variant_id),'stock',tasks,queue,50);
        if(pending.length){
          const output=await invoke(sync,{stockBatch:'true'},{item_codes:pending.map(r=>r.item_code),apply:true},started+240000);
          for(const result of output.results||[]){const problem=result.action==='error';await record(job,result.item_code,result,problem);summary.processed++;summary.errors+=Number(problem);if(result.action==='skipped')summary.skipped=(summary.skipped||0)+1;summary.results.push(result);}
        }
      }else{
        const pending=selectPending(rows.filter(r=>flags[job].some(f=>r[f])||(job==='prices'&&!r.shopify_product_id)),job,tasks,queue,5);
        for(const row of pending){
          if(Date.now()-started>180000)break;
          await work(row.item_code,async()=>{
            const output=await invoke(sync,{item_code:row.item_code,limit:'1',phase:row.shopify_product_id?phases[job]:'all',syncImages:'true',createMissing:'true'},undefined,started+240000);
            const result=output.results?.[0];if(!result)throw Error('Missing product result');return result;
          },job,summary);
        }
      }
    }
    const status=summary.errors?'partial':'success';
    check(await db.from('richmond_cron_runs').update({finished_at:new Date().toISOString(),status,summary}).eq('id',id));
    // Finish persistent cleanup BEFORE sending the HTTP response (serverless may freeze afterwards).
    check(await db.rpc('richmond_release_lock',{lock_owner:id}));locked=false;
    return res.status(summary.errors?207:200).json({ok:!summary.errors,run_id:id,job,...summary});
  }catch(error){
    // Only our own bounded messages are logged; never an Axios config or supplier credential URL.
    const safe=/^(Handler failed|Automatic publication|Missing product|Publication|Supplier|Incomplete|Shopify|Supabase|Inventory)/.test(error.message||'')?error.message:'Pipeline operation failed';
    console.error('Richmond cron failed',{run_id:id,job,error:safe});
    if(locked)await db.from('richmond_cron_runs').update({finished_at:new Date().toISOString(),status:'failed',summary:{...summary,error:safe}}).eq('id',id);
    if(locked){const released=await db.rpc('richmond_release_lock',{lock_owner:id});if(!released.error)locked=false;}
    return res.status(500).json({ok:false,run_id:id,job,error:safe});
  }finally{if(locked)await db.rpc('richmond_release_lock',{lock_owner:id});}
}
async function work(code,fn,job,summary){
  let result;try{result=await fn();}catch(e){result={action:'error',error:/^(Publication|Supplier|Incomplete|Shopify|Inventory|Handler failed)/.test(e.message||'')?e.message:'Operation failed',upstream_status:e.response?.status||null};}
  const problem=result.action==='error'||Boolean(result.errors?.length);
  await record(job,code,result,problem);summary.processed++;summary.errors+=Number(problem);summary.results.push({item_code:code,...result});
}

async function publish(entry,row){
  if(!row||String(row.shopify_product_id)!==entry.product_id)throw Error('Publication identity mismatch');
  const waiting=['needs_stock_update','needs_price_update','needs_compare_at_price_update','needs_description_update','needs_images_update','needs_status_update'].filter(k=>row[k]);
  if(waiting.length)return {action:'skipped',reason:'Waiting for '+waiting.join(',')};
  if(row.status!=='active'||row.raw_data?.details?.['Product Status']!=='Actief')return {action:'skipped',reason:'Supplier not active'};
  const stamp=String(row.last_richmond_sync||'');
  const age=Date.now()-Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(stamp)?stamp:stamp+'Z');
  if(!Number.isFinite(age)||age>7*3600000)throw Error('Supplier stock stale');
  if(!(Number(row.price)>0)||!Number.isInteger(row.stock_quantity)||row.stock_quantity<0)throw Error('Incomplete supplier price/stock');
  const publication=process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID;
  if(!/^gid:\/\/shopify\/Publication\/\d+$/.test(publication||''))throw Error('Publication ID missing');
  const token=check(await db.from('shopify_auth').select('access_token').single())?.access_token;
  if(!token)throw Error('Shopify token missing');
  const shop=String(process.env.SHOPIFY_SHOP||'').replace(/^https?:\/\//,'').replace(/\/$/,'');
  if(!/^[a-z0-9-]+\.myshopify\.com$/i.test(shop))throw Error('Shopify domain invalid');
  const client=axios.create({baseURL:`https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION||'2026-04'}`,timeout:30000,headers:{'X-Shopify-Access-Token':token}});
  const gql=async(query,variables)=>{const r=await client.post('/graphql.json',{query,variables});if(r.data.errors?.length||!r.data.data)throw Error('Shopify publication query rejected');return r.data.data;};
  const live=(await client.get(`/products/${entry.product_id}.json`)).data.product;
  const variant=live.variants?.find(v=>String(v.id)===String(row.shopify_variant_id));
  if(live.vendor!=='Richmond Interiors'||!variant||![row.item_code,row.item_code_new].includes(String(variant.sku)))throw Error('Publication identity mismatch');
  if(live.status==='archived')return {action:'skipped',reason:'Merchant archive preserved'};
  if(!['active','draft'].includes(live.status)||!live.images?.length||!String(live.body_html||'').replace(/<[^>]*>/g,'').trim()||Number(variant.price)!==Number(row.price))throw Error('Incomplete live product');
  // Check actual configured-location stock again; supplier stock is not merchant-owned stock.
  const inventory=(await client.get('/inventory_levels.json',{params:{inventory_item_ids:variant.inventory_item_id,location_ids:process.env.SHOPIFY_LOCATION_ID}})).data.inventory_levels;
  if(!inventory?.some(l=>String(l.location_id)===String(process.env.SHOPIFY_LOCATION_ID)&&l.available===row.stock_quantity))throw Error('Inventory not verified for publication');
  const variables={id:`gid://shopify/Product/${entry.product_id}`,publication};
  const verifyQuery='query($id:ID!,$publication:ID!){product(id:$id){status publishedOnPublication(publicationId:$publication)}}';
  let state=(await gql(verifyQuery,variables)).product;
  if(!state)throw Error('Publication product absent');
  try {
  if(live.status==='draft')await client.put(`/products/${entry.product_id}.json`,{product:{id:entry.product_id,status:'active',published_at:null}});
  if(!state.publishedOnPublication || live.status==='draft'){
    const result=await gql('mutation($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){userErrors{field message}}}',{id:variables.id,input:[{publicationId:publication}]});
    if(result.publishablePublish?.userErrors?.length)throw Error('Publication rejected');
  }
  state=(await gql(verifyQuery,variables)).product;
  if(state?.status!=='ACTIVE'||!state.publishedOnPublication)throw Error('Publication verification failed');
  } catch(error) {
    if(live.status==='draft'){
      try{await client.put(`/products/${entry.product_id}.json`,{product:{id:entry.product_id,status:'draft'}});}
      catch{throw Error('Publication failed AND rollback failed; immediate review required');}
    }
    throw error;
  }
  check(await db.from('richmond_publication_queue').update({status:'published',published_at:new Date().toISOString()}).eq('item_code',entry.item_code).eq('product_id',entry.product_id));
  return {action:'published_and_verified',product_id:entry.product_id};
}

async function preflight(res){
  let stage='supabase_tables';
  const diagnostic={};
  const fail=(error,extra={})=>res.status(503).json({ok:false,read_only:true,stage,error,...diagnostic,...extra});
  try{
    for(const t of ['richmond_cron_lock','richmond_cron_runs','richmond_cron_tasks','richmond_publication_queue']){
      stage=`supabase_table:${t}`;
      const result=await db.from(t).select('*').limit(1);
      if(result.error)return fail('Cannot read tracking table',{database_code:result.error.code||null});
    }
    stage='supabase_shopify_auth';
    const authResult=await db.from('shopify_auth').select('access_token').single();
    if(authResult.error)return fail('Cannot read a unique Shopify connection',{database_code:authResult.error.code||null});
    const token=authResult.data?.access_token;
    if(!token)return fail('Shopify token missing');
    stage='shopify_configuration';
    const shop=String(process.env.SHOPIFY_SHOP||'').replace(/^https?:\/\//,'').replace(/\/$/,'');
    if(!/^[a-z0-9-]+\.myshopify\.com$/i.test(shop))return fail('Shopify domain invalid');
    const endpoint=`https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION||'2026-04'}/graphql.json`;
    const options={headers:{'X-Shopify-Access-Token':token},timeout:30000,maxRedirects:0};
    stage='shopify_access_scopes';
    const response=await axios.post(endpoint,{query:'{currentAppInstallation{accessScopes{handle}}}'},options);
    if(response.data.errors?.length||!response.data.data?.currentAppInstallation)return fail('Cannot read Shopify app installation',{graphql_codes:(response.data.errors||[]).map(e=>e.extensions?.code||'UNKNOWN')});
    const scopes=response.data.data.currentAppInstallation.accessScopes.map(s=>s.handle);
    diagnostic.granted_scopes=scopes;
    const missing=['write_products','write_inventory','write_publications'].filter(s=>!scopes.includes(s));
    let publications=null;
    if(scopes.includes('read_publications')||scopes.includes('write_publications')){
      stage='shopify_publications';
      const publicationResponse=await axios.post(endpoint,{query:'{publications(first:100){nodes{id name} pageInfo{hasNextPage}}}'},options);
      if(publicationResponse.data.errors?.length||!publicationResponse.data.data?.publications)return fail('Cannot read publications',{graphql_codes:(publicationResponse.data.errors||[]).map(e=>e.extensions?.code||'UNKNOWN')});
      publications=publicationResponse.data.data.publications;
    }
    const configurationMissing=[];
    if(!/^gid:\/\/shopify\/Publication\/\d+$/.test(process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID||''))configurationMissing.push('SHOPIFY_ONLINE_STORE_PUBLICATION_ID');
    if(!/^\d+$/.test(process.env.SHOPIFY_LOCATION_ID||''))configurationMissing.push('SHOPIFY_LOCATION_ID');
    return res.status(200).json({ok:!missing.length&&!configurationMissing.length,read_only:true,granted_scopes:scopes,missing_scopes:missing,configuration_missing:configurationMissing,publications,configured_publication:process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID||null,configured_location:process.env.SHOPIFY_LOCATION_ID||null,enabled:process.env.RICHMOND_CRON_ENABLED==='true'});
  }catch(error){return fail('Preflight request failed',{upstream_status:error.response?.status||null,error_type:String(error.name||'Error'),network_code:/^[A-Z_\d]+$/.test(error.code||'')?error.code:null});}
}
