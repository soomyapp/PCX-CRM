const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const now = () => new Date().toISOString();
const id = (prefix='') => prefix + crypto.randomUUID();
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const accessCodeKey = async (secret) => {
  if (!secret) throw new Error('Falta configurar DEVELOPER_KEY en el Worker.');
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pcx-access-codes-v1:' + secret));
  return crypto.subtle.importKey('raw', material, {name:'AES-GCM'}, false, ['encrypt','decrypt']);
};
const bytesToBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64ToBytes = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0));
const encryptAccessCode = async (code, secret) => {
  const iv=crypto.getRandomValues(new Uint8Array(12)), key=await accessCodeKey(secret);
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(code));
  return {code_ciphertext:bytesToBase64(ciphertext),code_iv:bytesToBase64(iv)};
};
const decryptAccessCode = async (ciphertext, iv, secret) => {
  const key=await accessCodeKey(secret);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(iv)},key,base64ToBytes(ciphertext));
  return new TextDecoder().decode(plain);
};
const generateEightDigitCode = () => {
  const limit=Math.floor(0x100000000/90000000)*90000000;
  let value;
  do { const sample=new Uint32Array(1); crypto.getRandomValues(sample); value=sample[0]; } while(value>=limit);
  return String(10000000+(value%90000000));
};
const slug = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || crypto.randomUUID();
const safeInt = (v, d=0) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d;
const inWindow = (start, end) => { const t=Date.now(); const bound=(v,isEnd)=>{ if(!v)return null; const x=String(v); return Date.parse(x.length===10 ? `${x}T${isEnd?'23:59:59.999':'00:00:00.000'}Z` : x); }; const a=bound(start,false), b=bound(end,true); return (a===null||!Number.isNaN(a)&&a<=t) && (b===null||!Number.isNaN(b)&&b>=t); };
const parse = async req => { try { return await req.json(); } catch { return {}; } };
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const all = async (env, sql, ...args) => (await stmt(env,sql,...args).all()).results || [];
const first = async (env, sql, ...args) => await stmt(env,sql,...args).first();
const run = async (env, sql, ...args) => await stmt(env,sql,...args).run();

// ───────────────────────── Constantes y utilidades añadidas ─────────────────────────
const SALE_STATUSES = ['confirmed','processing','shipped','completed'];
const ORDER_STATUSES = ['pending', ...SALE_STATUSES, 'cancelled'];
const TZ_OFFSET_MIN = -240; // America/Caracas (UTC-4, sin horario de verano)
const SETTINGS_KEYS = ['store_name','currency','whatsapp','instagram','facebook','tiktok'];
const PUBLIC_SETTINGS = SETTINGS_KEYS;
const ALLOWED_UPLOADS = ['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','application/pdf'];
const MAX_UPLOAD = 20 * 1024 * 1024;
const MEDIA_KEY_RE = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]{1,220}$/;
const localDay = d => new Date(d.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0,10);
const parseDbDate = s => new Date(String(s).includes('T') ? s : String(s).replace(' ','T') + 'Z');
const dbDate = d => d.toISOString().slice(0,19).replace('T',' ');
const flag = (v, d=1) => v === undefined || v === null || v === '' ? d : (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const nullIfEmpty = v => (v === undefined || v === null || String(v).trim() === '') ? null : v;
const okUrl = v => { if (v === null || v === undefined || v === '') return true; const x = String(v); return /^https:\/\//i.test(x) || x.startsWith('/') || x.startsWith('#'); };
const safeEqual = async (a, b) => { const [x,y] = await Promise.all([sha256(String(a)), sha256(String(b))]); let d = 0; for (let i=0;i<x.length;i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i); return d === 0; };

function sniffType(bytes) {
  const at = (arr, o=0) => arr.every((v,i) => bytes[o+i] === v);
  if (at([0xFF,0xD8,0xFF])) return 'image/jpeg';
  if (at([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])) return 'image/png';
  if (at([0x47,0x49,0x46,0x38])) return 'image/gif';
  if (at([0x52,0x49,0x46,0x46]) && at([0x57,0x45,0x42,0x50],8)) return 'image/webp';
  if (at([0x25,0x50,0x44,0x46])) return 'application/pdf';
  if (at([0x1A,0x45,0xDF,0xA3])) return 'video/webm';
  if (at([0x66,0x74,0x79,0x70],4)) { const brand = String.fromCharCode(...bytes.slice(8,12)); return (brand === 'avif' || brand === 'avis') ? 'image/avif' : 'video/mp4'; }
  return null;
}

async function rateLimited(env, request, bucket, max, windowSec) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const keyHash = (await sha256(ip)).slice(0,32);
    const ws = Math.floor(Date.now()/1000/windowSec) * windowSec;
    await run(env,'INSERT INTO rate_limits(bucket,key_hash,window_start,hits) VALUES(?,?,?,1) ON CONFLICT(bucket,key_hash,window_start) DO UPDATE SET hits=hits+1',bucket,keyHash,ws);
    const row = await first(env,'SELECT hits FROM rate_limits WHERE bucket=? AND key_hash=? AND window_start=?',bucket,keyHash,ws);
    return (row?.hits || 0) > max;
  } catch { return false; } // si la tabla aún no existe no se bloquea el servicio
}
async function housekeeping(env) {
  try {
    await run(env,'DELETE FROM rate_limits WHERE window_start<?',Math.floor(Date.now()/1000)-86400);
    await run(env,'DELETE FROM admin_sessions WHERE expires_at<?',now());
    await run(env,'DELETE FROM login_attempts WHERE created_at<?',dbDate(new Date(Date.now()-86400000)));
  } catch {}
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = origin === 'https://corporacionpcx.pages.dev' || origin === 'https://corporacionpcx.com' || origin === 'https://www.corporacionpcx.com' || /^https:\/\/[a-z0-9-]+\.corporacionpcx\.pages\.dev$/i.test(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return { 'access-control-allow-origin': allowed ? origin : 'https://corporacionpcx.pages.dev', 'vary':'Origin', 'access-control-allow-methods':'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers':'Content-Type,Authorization,X-File-Name,X-Category-ID,X-Published,X-Developer-Key', 'access-control-max-age':'86400' };
}
const mediaUrl = (env, key) => `${env.PUBLIC_API_URL || 'https://pcx-crm-api.lcreativo.workers.dev'}/media/${key}`;
async function requireAdmin(request, env) {
  const token = (request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
  if (!token) return null;
  return await first(env, `SELECT s.id,s.user_id,s.expires_at,u.username,u.role FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, await sha256(token), now());
}

// ───────────────────────── Pedidos ─────────────────────────
async function createOrder(env, body) {
  const customer = body.customer || {};
  const name = String(customer.name||'').trim().slice(0,120);
  const phone = String(customer.phone||'').trim().slice(0,40);
  const rawItems = Array.isArray(body.items) ? body.items.slice(0,50) : [];
  if (!name || !phone || !rawItems.length) throw new Error('Faltan datos del cliente o productos.');
  const merged = new Map(), variantOf = new Map();
  for (const item of rawItems) { const pid = String(item.product_id||''); const qty = Math.max(1, Math.min(100, safeInt(item.quantity,1))); merged.set(pid, Math.min(100,(merged.get(pid)||0)+qty)); if(item.variant&&!variantOf.has(pid)) variantOf.set(pid,String(item.variant).slice(0,40)); }
  const normalized=[]; let subtotal=0;
  for (const [pid, qty] of merged) {
    const product = await first(env,'SELECT id,name,price_cents,stock_qty,active FROM products WHERE id=?',pid);
    if (!product || !product.active) throw new Error('Uno de los productos ya no está disponible.');
    if (product.stock_qty < qty) throw new Error(`Stock insuficiente para ${product.name} (disponible: ${product.stock_qty}).`);
    const line = product.price_cents * qty; subtotal += line;
    normalized.push({product_id:product.id,name:product.name,variant:variantOf.get(pid)||null,quantity:qty,unit_price_cents:product.price_cents,line_total_cents:line});
  }
  let discount=0, couponCode=null;
  if (body.coupon_code) {
    const c=await first(env,'SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND active=1',String(body.coupon_code).trim());
    if (!c || !inWindow(c.starts_at,c.ends_at) || (c.usage_limit && c.used_count>=c.usage_limit) || subtotal<c.min_order_cents) throw new Error('El cupón ya no es válido para esta compra.');
    discount=c.discount_type==='percent' ? Math.round(subtotal*c.discount_value/100) : Math.min(subtotal,c.discount_value);
    couponCode=c.code;
  }
  const existingCustomer = await first(env,'SELECT id FROM customers WHERE phone=? ORDER BY created_at LIMIT 1',phone);
  const customerId = existingCustomer?.id || id('cus_'), newCustomer = !existingCustomer;
  const orderId=id('ord_'), orderNumber='PCX-'+Date.now().toString(36).toUpperCase()+crypto.randomUUID().slice(0,2).toUpperCase();
  const statements=[];
  if (newCustomer) statements.push(stmt(env,'INSERT INTO customers(id,name,phone) VALUES(?,?,?)',customerId,name,phone));
  else statements.push(stmt(env,'UPDATE customers SET name=? WHERE id=?',name,customerId));
  statements.push(stmt(env,'INSERT INTO orders(id,customer_id,order_number,status,subtotal_cents,discount_cents,total_cents,coupon_code,shipping_json,items_json) VALUES(?,?,?,\'pending\',?,?,?,?,?,?)',orderId,customerId,orderNumber,subtotal,discount,subtotal-discount,couponCode,JSON.stringify(body.shipping||{}).slice(0,2000),JSON.stringify(normalized)));
  for (const p of normalized) statements.push(stmt(env,'UPDATE products SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock_qty>=?',p.quantity,p.product_id,p.quantity));
  if (couponCode) statements.push(stmt(env,'UPDATE coupons SET used_count=used_count+1 WHERE code=? AND (usage_limit IS NULL OR used_count<usage_limit)',couponCode));
  const results=await env.DB.batch(statements);
  if (results.some(r=>r.success===false)) throw new Error('No se pudo registrar el pedido.');
  const stockResults=results.slice(2,2+normalized.length), couponResult=couponCode?results[2+normalized.length]:null;
  const stockBad=stockResults.some(r=>(r.meta?.changes??1)!==1), couponBad=couponResult&&(couponResult.meta?.changes??1)!==1;
  if (stockBad||couponBad) {
    const rollback=[]; normalized.forEach((p,i)=>{ if((stockResults[i]?.meta?.changes??1)===1) rollback.push(stmt(env,'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',p.quantity,p.product_id)); });
    rollback.push(stmt(env,'DELETE FROM orders WHERE id=?',orderId));
    if(newCustomer) rollback.push(stmt(env,'DELETE FROM customers WHERE id=?',customerId));
    if(couponCode&&!couponBad) rollback.push(stmt(env,'UPDATE coupons SET used_count=MAX(0,used_count-1) WHERE code=?',couponCode));
    await env.DB.batch(rollback);
    throw new Error(couponBad?'El cupón alcanzó su límite de usos.':'El inventario cambió durante la compra. Intenta nuevamente.');
  }
  return {id:orderId,order_number:orderNumber,subtotal_cents:subtotal,discount_cents:discount,total_cents:subtotal-discount,status:'pending',items:normalized,coupon_code:couponCode};
}

// Cambio de estado con coherencia de inventario (cancelar devuelve stock; reactivar lo descuenta).
async function changeOrderStatus(env, orderId, status) {
  if (!ORDER_STATUSES.includes(status)) return {error:'Estado de pedido no válido.',code:400};
  const order = await first(env,'SELECT id,status,items_json,coupon_code FROM orders WHERE id=?',orderId);
  if (!order) return {error:'Pedido no encontrado.',code:404};
  if (order.status === status) return {ok:true};
  let items=[]; try { items=JSON.parse(order.items_json||'[]'); } catch {}
  const statements=[];
  if (status==='cancelled' && order.status!=='cancelled') {
    for (const it of items) statements.push(stmt(env,'UPDATE products SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP WHERE id=?',it.quantity,it.product_id));
    if (order.coupon_code) statements.push(stmt(env,'UPDATE coupons SET used_count=MAX(0,used_count-1) WHERE code=?',order.coupon_code));
  } else if (order.status==='cancelled' && status!=='cancelled') {
    for (const it of items) { const p=await first(env,'SELECT stock_qty,name FROM products WHERE id=?',it.product_id); if (p && p.stock_qty<it.quantity) return {error:`No hay stock suficiente de ${p.name} para reactivar el pedido.`,code:409}; }
    for (const it of items) statements.push(stmt(env,'UPDATE products SET stock_qty=MAX(0,stock_qty-?),updated_at=CURRENT_TIMESTAMP WHERE id=?',it.quantity,it.product_id));
    if (order.coupon_code) statements.push(stmt(env,'UPDATE coupons SET used_count=used_count+1 WHERE code=?',order.coupon_code));
  }
  statements.push(stmt(env,'UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',status,orderId));
  await env.DB.batch(statements);
  return {ok:true};
}

// ───────────────────────── Métricas de ventas ─────────────────────────
async function salesMetrics(env, daysParam) {
  const days = Math.min(365, Math.max(7, safeInt(daysParam,30)));
  const end = new Date();
  const dayKeys = []; for (let i=days-1;i>=0;i--) dayKeys.push(localDay(new Date(end.getTime()-i*86400000)));
  const startKey = dayKeys[0], prevStartKey = localDay(new Date(end.getTime()-(2*days-1)*86400000));
  const since = dbDate(new Date(end.getTime()-(2*days+1)*86400000));
  const rows = await all(env,'SELECT id,status,total_cents,created_at,items_json FROM orders WHERE created_at>=? ORDER BY created_at LIMIT 20000',since);
  const cats = new Map((await all(env,'SELECT p.id,COALESCE(c.name,\'Sin categoría\') AS cat FROM products p LEFT JOIN categories c ON c.id=p.category_id')).map(r=>[r.id,r.cat]));
  const daily = new Map(dayKeys.map(k=>[k,{date:k,sales_cents:0,orders:0}]));
  const totals = {sales_cents:0,orders:0,units:0,pending_orders:0,pending_cents:0,cancelled_orders:0};
  const previous = {sales_cents:0,orders:0};
  const top = new Map(), byCat = new Map(), byStatus = new Map();
  for (const o of rows) {
    const day = localDay(parseDbDate(o.created_at)), current = day >= startKey, prev = !current && day >= prevStartKey;
    const isSale = SALE_STATUSES.includes(o.status);
    if (prev && isSale) { previous.sales_cents += o.total_cents; previous.orders++; }
    if (!current) continue;
    const st = byStatus.get(o.status) || {status:o.status,orders:0,total_cents:0}; st.orders++; st.total_cents += o.total_cents; byStatus.set(o.status,st);
    if (o.status==='pending') { totals.pending_orders++; totals.pending_cents += o.total_cents; }
    if (o.status==='cancelled') totals.cancelled_orders++;
    if (!isSale) continue;
    totals.sales_cents += o.total_cents; totals.orders++;
    const d = daily.get(day); if (d) { d.sales_cents += o.total_cents; d.orders++; }
    let items=[]; try { items=JSON.parse(o.items_json||'[]'); } catch {}
    for (const it of items) {
      totals.units += it.quantity||0;
      const t = top.get(it.product_id) || {product_id:it.product_id,name:it.name,units:0,revenue_cents:0}; t.units += it.quantity||0; t.revenue_cents += it.line_total_cents||0; top.set(it.product_id,t);
      const cn = cats.get(it.product_id) || 'Sin categoría'; const c = byCat.get(cn) || {category:cn,units:0,revenue_cents:0}; c.units += it.quantity||0; c.revenue_cents += it.line_total_cents||0; byCat.set(cn,c);
    }
  }
  totals.avg_ticket_cents = totals.orders ? Math.round(totals.sales_cents/totals.orders) : 0;
  const lifetime = await first(env,`SELECT COALESCE(SUM(total_cents),0) AS sales_cents,COUNT(*) AS orders FROM orders WHERE status IN (${SALE_STATUSES.map(()=>'?').join(',')})`,...SALE_STATUSES);
  const lowStock = await all(env,'SELECT id,name,sku,stock_qty FROM products WHERE active=1 AND stock_qty<=5 ORDER BY stock_qty,name LIMIT 20');
  return {range:{days,from:startKey,to:dayKeys[dayKeys.length-1],timezone:'America/Caracas'},sale_statuses:SALE_STATUSES,totals,previous,lifetime,
    daily:[...daily.values()],top_products:[...top.values()].sort((a,b)=>b.revenue_cents-a.revenue_cents).slice(0,8),
    by_category:[...byCat.values()].sort((a,b)=>b.revenue_cents-a.revenue_cents),by_status:ORDER_STATUSES.map(s=>byStatus.get(s)||{status:s,orders:0,total_cents:0}),low_stock:lowStock};
}

// ───────────────────────── Archivos (R2) ─────────────────────────
async function serveMedia(request, env, url, cors) {
  let key; try { key = decodeURIComponent(url.pathname.slice(7)); } catch { return new Response('Bad request',{status:400,headers:cors}); }
  if (!MEDIA_KEY_RE.test(key) || key.includes('..')) return new Response('Not found',{status:404,headers:cors});
  const h = new Headers(cors);
  h.set('cache-control','public, max-age=31536000, immutable'); h.set('accept-ranges','bytes'); h.set('x-content-type-options','nosniff'); h.set('cross-origin-resource-policy','cross-origin');
  if (request.method==='HEAD') {
    const head = await env.MEDIA.head(key); if (!head) return new Response(null,{status:404,headers:cors});
    head.writeHttpMetadata(h); h.set('etag',head.httpEtag); h.set('content-length',String(head.size)); return new Response(null,{status:200,headers:h});
  }
  const rangeHeader = request.headers.get('range');
  const obj = await env.MEDIA.get(key, rangeHeader ? {range:request.headers} : undefined);
  if (!obj) return new Response('Not found',{status:404,headers:cors});
  obj.writeHttpMetadata(h); h.set('etag',obj.httpEtag);
  if (rangeHeader && obj.range) {
    let {offset,length} = obj.range; if (offset===undefined) { const suffix=obj.range.suffix||0; offset=Math.max(0,obj.size-suffix); length=obj.size-offset; } if (length===undefined) length=obj.size-offset;
    h.set('content-range',`bytes ${offset}-${offset+length-1}/${obj.size}`); h.set('content-length',String(length));
    return new Response(obj.body,{status:206,headers:h});
  }
  h.set('content-length',String(obj.size));
  return new Response(obj.body,{headers:h});
}

// ───────────────────────── API pública ─────────────────────────
async function publicApi(request, env, url) {
  if (url.pathname==='/api/health') {
    const db=await first(env,'SELECT COUNT(*) AS products FROM products');
    let bucket='ok'; try { await env.MEDIA.list({limit:1}); } catch { bucket='error'; }
    let gallery='ok'; try { await first(env,'SELECT published,sort_order,title FROM media_assets LIMIT 1'); await first(env,'SELECT 1 FROM rate_limits LIMIT 1'); await first(env,'SELECT variants FROM products LIMIT 1'); } catch { gallery='faltan migraciones 0003/0004'; }
    return json({ok:true,service:'pcx-crm-api',database:'ok',products:db?.products||0,media:bucket,gallery,time:now()});
  }
  if (url.pathname==='/api/catalog' && request.method==='GET') {
    const categories=await all(env,`SELECT c.*,COALESCE(m.public_url,c.image_url) AS image_url,m.content_type AS image_content_type FROM categories c LEFT JOIN media_assets m ON m.id=COALESCE(c.media_id,(SELECT ma.id FROM media_assets ma WHERE ma.category_id=c.id AND ma.content_type LIKE 'image/%' ORDER BY ma.created_at DESC LIMIT 1)) WHERE c.active=1 ORDER BY c.sort_order,c.name`);
    const products=await all(env,`SELECT p.*,c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND (c.id IS NULL OR c.active=1) ORDER BY p.featured DESC,p.created_at DESC`);
    const productMedia=await all(env,`SELECT pi.product_id,pi.sort_order,pi.is_primary,m.id AS media_id,m.public_url,m.content_type,m.filename FROM product_images pi JOIN media_assets m ON m.id=pi.media_id ORDER BY pi.product_id,pi.is_primary DESC,pi.sort_order ASC`);
    const mediaByProduct=new Map(); for(const item of productMedia){if(!mediaByProduct.has(item.product_id))mediaByProduct.set(item.product_id,[]);mediaByProduct.get(item.product_id).push({id:item.media_id,url:item.public_url,type:String(item.content_type||'').startsWith('video/')?'video':'image',filename:item.filename,sort_order:item.sort_order,is_primary:!!item.is_primary});}
    let galleryRows=[]; try { galleryRows=await all(env,`SELECT m.id,m.category_id,c.name AS category_name,m.public_url AS url,m.content_type,m.filename,m.title,m.alt_text,m.sort_order FROM media_assets m JOIN categories c ON c.id=m.category_id AND c.active=1 WHERE m.published=1 AND (m.content_type LIKE 'image/%' OR m.content_type LIKE 'video/%') ORDER BY c.sort_order,c.name,m.sort_order,m.created_at DESC`); } catch { galleryRows=[]; }
    const gallery=galleryRows.map(g=>({id:g.id,category_id:g.category_id,category_name:g.category_name,url:g.url,type:String(g.content_type||'').startsWith('video/')?'video':'image',title:g.title||'',alt:g.alt_text||g.title||g.category_name,filename:g.filename}));
    const counts=new Map(); for(const p of products) counts.set(p.category_id,(counts.get(p.category_id)||0)+1);
    const bannersAll=await all(env,`SELECT b.*,m.public_url AS image,m.content_type AS image_content_type FROM banners b LEFT JOIN media_assets m ON m.id=b.media_id WHERE b.active=1 ORDER BY b.sort_order`);
    const popupsAll=await all(env,`SELECT p.*,m.public_url AS image,m.content_type AS image_content_type FROM popups p LEFT JOIN media_assets m ON m.id=p.media_id WHERE p.active=1 ORDER BY p.created_at DESC`);
    const normalizePosition=v=>{const x=String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();if(x.includes('hero')||x.includes('portada')||x==='home')return 'hero';if(x.includes('categor'))return 'category';if(x.includes('popup')||x.includes('pop-out')||x.includes('emergente'))return 'popup';return 'promotion';};
    const asVideo=x=>String(x.image_content_type||'').startsWith('video/');
    const banners=bannersAll.filter(x=>inWindow(x.starts_at,x.ends_at)).map(x=>({...x,position:normalizePosition(x.position),image_url:asVideo(x)?null:(x.image||null),video_url:x.video_url||(asVideo(x)?x.image:null),media_type:asVideo(x)||x.video_url?'video':'image'}));
    const popups=popupsAll.filter(x=>inWindow(x.starts_at,x.ends_at)).map(x=>({...x,image_url:asVideo(x)?null:(x.image||null),video_url:x.video_url||(asVideo(x)?x.image:null)}));
    const settingRows=await all(env,`SELECT key,value FROM store_settings WHERE key IN (${PUBLIC_SETTINGS.map(()=>'?').join(',')})`,...PUBLIC_SETTINGS);
    const settings=Object.fromEntries(settingRows.map(r=>[r.key,r.value]));
    return json({generated_at:now(),settings,
      categories:categories.map(c=>({...c,product_count:counts.get(c.id)||0,gallery:gallery.filter(g=>g.category_id===c.id)})),gallery,
      products:products.map(p=>{const g=mediaByProduct.get(p.id)||[];return {...p,variants:parseVariants(p.variants),price:p.price_cents/100,compare_at_price:p.compare_at_cents?p.compare_at_cents/100:null,in_stock:p.stock_qty>0,image:p.image_url,image_url:p.image_url,images:g,media:[...(p.image_url?[{url:p.image_url,type:'image',is_primary:true}]:[]),...(p.video_url?[{url:p.video_url,type:'video'}]:[]),...g]};}),banners,popups},200,{'cache-control':'no-cache'});
  }
  if (url.pathname==='/api/coupons/validate' && request.method==='POST') {
    if (await rateLimited(env,request,'coupon',60,600)) return json({valid:false,error:'Demasiados intentos. Espera unos minutos.'},429);
    const b=await parse(request), code=String(b.code||'').trim().toUpperCase(), subtotal=Math.max(0,safeInt(b.subtotal_cents));
    const c=await first(env,'SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND active=1',code);
    if(!c) return json({valid:false,error:'Cupón no válido'},400);
    if(!inWindow(c.starts_at,c.ends_at)||(c.usage_limit&&c.used_count>=c.usage_limit)) return json({valid:false,error:'El cupón no está disponible.'},400);
    if(subtotal<c.min_order_cents) return json({valid:false,error:`El cupón requiere una compra mínima de $${(c.min_order_cents/100).toFixed(2)}.`},400);
    const discount=c.discount_type==='percent'?Math.round(subtotal*c.discount_value/100):Math.min(subtotal,c.discount_value);
    return json({valid:true,code:c.code,discount_cents:discount});
  }
  if (url.pathname==='/api/leads' && request.method==='POST') {
    if (await rateLimited(env,request,'lead',10,600)) return json({error:'Demasiadas solicitudes. Inténtalo más tarde.'},429);
    const b=await parse(request), name=String(b.name||'').trim().slice(0,120),phone=String(b.phone||'').trim().slice(0,40),topic=String(b.topic||'Consulta').trim().slice(0,80);
    if(!name||!phone) return json({error:'Nombre y teléfono son obligatorios.'},400);
    const ticket='PCX-'+Date.now().toString(36).toUpperCase()+crypto.randomUUID().slice(0,2).toUpperCase();
    await run(env,'INSERT INTO leads(id,ticket,name,phone,topic,message) VALUES(?,?,?,?,?,?)',id('lead_'),ticket,name,phone,topic,String(b.message||'').slice(0,1800));
    return json({ok:true,ticket},201);
  }
  if (url.pathname==='/api/orders' && request.method==='POST') {
    if (await rateLimited(env,request,'order',20,600)) return json({error:'Demasiados pedidos desde esta conexión. Inténtalo en unos minutos.'},429);
    try { return json(await createOrder(env,await parse(request)),201); } catch(e) { return json({error:e.message||'No se pudo registrar el pedido.'},400); }
  }
  return null;
}

// ───────────────────────── Validación de colecciones admin ─────────────────────────
async function cleanCollection(env, name, b, creating) {
  const o = {};
  const has = k => b[k] !== undefined;
  const bad = msg => ({error:msg});
  if (name==='products') {
    if (has('name')||creating) { const v=String(b.name||'').trim(); if(!v) return bad('El nombre del producto es obligatorio.'); if(v.length>160) return bad('El nombre no puede superar 160 caracteres.'); o.name=v; }
    if (has('price_cents')||creating) { const v=safeInt(b.price_cents,-1); if(v<0||v>100000000) return bad('El precio no es válido.'); o.price_cents=v; }
    if (has('stock_qty')||creating) { const v=safeInt(b.stock_qty,-1); if(v<0||v>1000000) return bad('El stock no es válido.'); o.stock_qty=v; }
    if (has('compare_at_cents')) { const v=b.compare_at_cents; o.compare_at_cents=(v===null||v===''||Number(v)<=0)?null:safeInt(v); }
    if (has('category_id')) { const v=nullIfEmpty(b.category_id); if(v&&!(await first(env,'SELECT id FROM categories WHERE id=?',String(v)))) return bad('La categoría seleccionada no existe.'); o.category_id=v; }
    for (const k of ['sku','description']) if (has(k)) o[k]=String(b[k]??'').slice(0,k==='sku'?60:4000);
    for (const k of ['image_url','video_url']) if (has(k)) { if(!okUrl(b[k])) return bad('La URL del archivo no es válida.'); o[k]=nullIfEmpty(b[k]); }
    if (has('variants')) { const vs=cleanVariants(b.variants); o.variants=vs.length?JSON.stringify(vs):null; }
    if (has('active')) o.active=flag(b.active); if (has('featured')) o.featured=flag(b.featured,0);
    if (creating) { o.active=has('active')?o.active:1; o.featured=has('featured')?o.featured:0; }
  } else if (name==='categories') {
    if (has('name')) { const v=String(b.name||'').trim(); if(!v) return bad('El nombre de la categoría es obligatorio.'); if(v.length>60) return bad('El nombre no puede superar 60 caracteres.'); o.name=v; }
    if (has('description')) o.description=String(b.description||'').slice(0,300);
    if (has('sort_order')) o.sort_order=safeInt(b.sort_order,0);
    if (has('active')) o.active=flag(b.active);
    if (has('media_id')) { const v=nullIfEmpty(b.media_id); if(v&&!(await first(env,'SELECT id FROM media_assets WHERE id=?',String(v)))) return bad('El archivo seleccionado no existe.'); o.media_id=v; }
    if (has('image_url')) { if(!okUrl(b.image_url)) return bad('La URL de la imagen no es válida.'); o.image_url=nullIfEmpty(b.image_url); }
  } else if (name==='coupons') {
    if (has('code')||creating) { const v=String(b.code||'').trim().toUpperCase(); if(!/^[A-Z0-9_-]{3,32}$/.test(v)) return bad('El código debe tener entre 3 y 32 caracteres (letras, números, - o _).'); o.code=v; }
    if (has('discount_type')||creating) { const v=String(b.discount_type||''); if(!['percent','fixed'].includes(v)) return bad('Tipo de descuento no válido.'); o.discount_type=v; }
    if (has('discount_value')||creating) { const v=safeInt(b.discount_value,0); if(v<=0) return bad('El descuento debe ser mayor que cero.'); o.discount_value=v; }
    if ((o.discount_type||b.discount_type)==='percent' && (o.discount_value??safeInt(b.discount_value))>100) return bad('El porcentaje no puede superar 100.');
    if (has('min_order_cents')) o.min_order_cents=Math.max(0,safeInt(b.min_order_cents,0));
    if (has('usage_limit')) { const v=safeInt(b.usage_limit,0); o.usage_limit=v>0?v:null; }
    for (const k of ['starts_at','ends_at']) if (has(k)) o[k]=nullIfEmpty(b[k]);
    if (has('active')) o.active=flag(b.active);
  } else if (name==='banners'||name==='popups') {
    for (const k of ['title','subtitle','body','button_text','trigger_type','trigger_value']) if (has(k)&&(name==='banners'?['title','subtitle']:['title','body','button_text','trigger_type','trigger_value']).includes(k)) o[k]=String(b[k]??'').slice(0,k==='body'?1000:200);
    for (const k of ['link_url','button_url','video_url']) if (has(k)) { if(!okUrl(b[k])) return bad('El enlace no es válido (usa https:// o una ruta del sitio).'); o[k]=nullIfEmpty(b[k]); }
    if (name==='banners'&&has('position')) { const p=String(b.position||'promotion'); o.position=['hero','promotion','category'].includes(p)?p:'promotion'; }
    if (has('media_id')) { const v=nullIfEmpty(b.media_id); if(v&&!(await first(env,'SELECT id FROM media_assets WHERE id=?',String(v)))) return bad('El archivo seleccionado no existe.'); o.media_id=v; }
    if (has('sort_order')&&name==='banners') o.sort_order=safeInt(b.sort_order,0);
    for (const k of ['starts_at','ends_at']) if (has(k)) o[k]=nullIfEmpty(b[k]);
    if (has('active')) o.active=flag(b.active);
    if (creating&&!has('active')) o.active=1;
  }
  return {data:o};
}
const parseVariants=v=>{try{const a=JSON.parse(v||'[]');return Array.isArray(a)?a.filter(x=>typeof x==='string'&&x.trim()).slice(0,8):[]}catch{return []}};
const cleanVariants=v=>{const arr=Array.isArray(v)?v:String(v||'').split(/[\n,]/);const out=[];for(const x of arr){const t=String(x).trim().slice(0,40);if(t&&!out.includes(t))out.push(t)}return out.slice(0,8)};
const HAS_UPDATED_AT = new Set(['products','categories']);

async function uniqueSlug(env, table, base) {
  let s = slug(base);
  if (!(await first(env,`SELECT id FROM ${table} WHERE slug=? COLLATE NOCASE`,s))) return s;
  return s + '-' + crypto.randomUUID().slice(0,6);
}

async function devAuth(request, env) {
  if (await rateLimited(env,request,'devkey',30,900)) return json({error:'Demasiados intentos. Espera 15 minutos.'},429);
  const key=request.headers.get('X-Developer-Key')||'';
  if(!env.DEVELOPER_KEY||!(await safeEqual(key,env.DEVELOPER_KEY))) return json({error:'No autorizado.'},403);
  return null;
}

// ───────────────────────── API de administración ─────────────────────────
async function adminApi(request, env, url, ctx) {
  const path=url.pathname, method=request.method;
  if(path==='/api/admin/login' && method==='POST') {
    const ip=request.headers.get('CF-Connecting-IP')||'unknown', ipHash=await sha256(ip), since=dbDate(new Date(Date.now()-15*60*1000));
    const attempts=await first(env,'SELECT COUNT(*) AS n FROM login_attempts WHERE ip_hash=? AND created_at>? AND success=0',ipHash,since);
    if((attempts?.n||0)>=10) return json({error:'Demasiados intentos. Espera 15 minutos.'},429);
    const b=await parse(request), code=String(b.code||'').trim(), hash=await sha256(code);
    const access=await first(env,'SELECT * FROM access_codes WHERE code_hash=? AND active=1 AND (expires_at IS NULL OR expires_at>?)',hash,now());
    await run(env,'INSERT INTO login_attempts(id,ip_hash,success) VALUES(?,?,?)',id('try_'),ipHash,access?1:0);
    if(!access) return json({error:'Código de acceso inválido.'},401);
    const userId='pcx-admin';
    await run(env,`INSERT INTO admin_users(id,username,password_hash,password_salt,role,active) VALUES(?, 'PCX Admin','','','admin',1) ON CONFLICT(id) DO UPDATE SET active=1`,userId);
    const token=id('pcx_')+crypto.randomUUID().replaceAll('-','');
    await run(env,'INSERT INTO admin_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)',id('sess_'),userId,await sha256(token),new Date(Date.now()+12*3600*1000).toISOString());
    if (ctx?.waitUntil) ctx.waitUntil(housekeeping(env)); else await housekeeping(env);
    return json({ok:true,token,expires_in:43200});
  }
  const developerRoute=path.startsWith('/api/admin/access-codes');
  const session=developerRoute?null:await requireAdmin(request,env);
  if(path.startsWith('/api/admin/') && !developerRoute && !session) return json({error:'Sesión no válida o expirada.'},401);

  if(path==='/api/admin/logout' && method==='POST') { const token=(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,''); await run(env,'DELETE FROM admin_sessions WHERE token_hash=?',await sha256(token)); return json({ok:true}); }
  if(path==='/api/admin/overview' && method==='GET') {
    const row=await first(env,`SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM products WHERE active=1) AS products,(SELECT COUNT(*) FROM customers) AS customers,(SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status!='cancelled') AS revenue_cents,(SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status IN ('confirmed','processing','shipped','completed')) AS sales_cents`); return json(row||{});
  }
  if(path==='/api/admin/metrics' && method==='GET') return json(await salesMetrics(env,url.searchParams.get('days')));
  if(path==='/api/admin/settings' && method==='GET') { const rows=await all(env,'SELECT key,value FROM store_settings'); return json(Object.fromEntries(rows.map(x=>[x.key,x.value]))); }
  if(path==='/api/admin/settings' && (method==='PATCH'||method==='POST'||method==='PUT')) {
    const b=await parse(request), stmts=[];
    for(const [k,v] of Object.entries(b)) {
      if(!SETTINGS_KEYS.includes(k)) continue;
      let val=String(v??'').trim().slice(0,200);
      if(k==='whatsapp') { val=val.replace(/\D/g,''); if(val&&(val.length<8||val.length>15)) return json({error:'El número de WhatsApp debe tener entre 8 y 15 dígitos, con código de país (ej. 584244656724).'},400); }
      if(['instagram','facebook','tiktok'].includes(k)&&!okUrl(val)) return json({error:`El enlace de ${k} debe empezar por https://`},400);
      if(k==='currency'&&!['USD','VES'].includes(val)) val='USD';
      stmts.push(stmt(env,'INSERT INTO store_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',k,val));
    }
    if(stmts.length) await env.DB.batch(stmts);
    return json({ok:true});
  }
  const collections={
    products:{table:'products',fields:['category_id','name','description','price_cents','compare_at_cents','sku','stock_qty','active','featured','video_url','image_url','variants'], order:'created_at DESC'},
    categories:{table:'categories',fields:['name','description','sort_order','active','media_id','image_url'],order:'sort_order,name'},
    coupons:{table:'coupons',fields:['code','discount_type','discount_value','min_order_cents','usage_limit','starts_at','ends_at','active'],order:'created_at DESC'},
    banners:{table:'banners',fields:['title','subtitle','media_id','link_url','position','active','starts_at','ends_at','sort_order','video_url'],order:'sort_order'},
    popups:{table:'popups',fields:['title','body','media_id','button_text','button_url','trigger_type','trigger_value','active','starts_at','ends_at','video_url'],order:'created_at DESC'}
  };
  for(const [name,cfg] of Object.entries(collections)) {
    const base='/api/admin/'+name;
    if(path===base && method==='GET') {
      let sql=`SELECT * FROM ${cfg.table} ORDER BY ${cfg.order}`;
      if(name==='categories') sql=`SELECT c.*,COALESCE(m.public_url,c.image_url) AS image_url,m.content_type AS image_content_type,(SELECT COUNT(*) FROM media_assets g WHERE g.category_id=c.id AND g.published=1) AS published_media FROM categories c LEFT JOIN media_assets m ON m.id=COALESCE(c.media_id,(SELECT ma.id FROM media_assets ma WHERE ma.category_id=c.id AND ma.content_type LIKE 'image/%' ORDER BY ma.created_at DESC LIMIT 1)) ORDER BY c.sort_order,c.name`;
      if(name==='banners'||name==='popups') sql=`SELECT x.*,m.public_url AS image,m.content_type AS image_content_type FROM ${cfg.table} x LEFT JOIN media_assets m ON m.id=x.media_id ORDER BY x.${name==='banners'?'sort_order':'created_at'} ${name==='banners'?'ASC':'DESC'}`;
      if(name==='products') { const rows=await all(env,sql); const gallery=await all(env,`SELECT pi.product_id,pi.sort_order,pi.is_primary,m.id AS media_id,m.public_url,m.content_type,m.filename FROM product_images pi JOIN media_assets m ON m.id=pi.media_id ORDER BY pi.product_id,pi.is_primary DESC,pi.sort_order ASC`); const byProduct=new Map(); for(const item of gallery){if(!byProduct.has(item.product_id))byProduct.set(item.product_id,[]);byProduct.get(item.product_id).push({id:item.media_id,url:item.public_url,type:String(item.content_type||'').startsWith('video/')?'video':'image',sort_order:item.sort_order,is_primary:!!item.is_primary});} return json(rows.map(p=>({...p,variants:parseVariants(p.variants),images:byProduct.get(p.id)||[]}))); }
      return json(await all(env,sql));
    }
    if(path===base && method==='POST') {
      const b=await parse(request);
      const cleaned=await cleanCollection(env,name,b,true); if(cleaned.error) return json({error:cleaned.error},400);
      const data=cleaned.data; data.id=id({products:'prd_',categories:'cat_',coupons:'cpn_',banners:'ban_',popups:'pop_'}[name]);
      if(name==='categories') {
        if(!data.name) return json({error:'El nombre de la categoría es obligatorio.'},400);
        const existing=await first(env,'SELECT id,name,active FROM categories WHERE name=? COLLATE NOCASE',data.name);
        if(existing) {
          if(!existing.active) { await run(env,'UPDATE categories SET name=?,description=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?',data.name,data.description||'',existing.id); return json({ok:true,id:existing.id,reactivated:true},200); }
          return json({error:'Ya existe una categoría activa con ese nombre.'},409);
        }
        data.slug=await uniqueSlug(env,'categories',data.name);
      }
      if(name==='products') data.slug=await uniqueSlug(env,'products',b.slug||data.name);
      const cols=Object.keys(data), vals=cols.map(c=>data[c]);
      try { await run(env,`INSERT INTO ${cfg.table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`,...vals); }
      catch(e) { const msg=String(e?.message||e); if(/UNIQUE/i.test(msg)) return json({error:name==='coupons'?'Ya existe un cupón con ese código.':'Ya existe un registro con ese nombre.'},409); throw e; }
      if(name==='products'&&Array.isArray(b.gallery_media_ids)){let order=0;for(const mediaId of b.gallery_media_ids){if(!mediaId)continue;await run(env,'INSERT OR IGNORE INTO product_images(id,product_id,media_id,sort_order,is_primary) VALUES(?,?,?,?,?)',id('pimg_'),data.id,String(mediaId),order++,0);}}
      return json({ok:true,id:data.id},201);
    }
    const prefix=base+'/'; if(path.startsWith(prefix) && (method==='PATCH'||method==='DELETE')) {
      const rid=decodeURIComponent(path.slice(prefix.length));
      if(!(await first(env,`SELECT id FROM ${cfg.table} WHERE id=?`,rid))) return json({error:'Registro no encontrado.'},404);
      if(method==='DELETE') { if(name==='categories'&&url.searchParams.get('permanent')==='1'){ await env.DB.batch([stmt(env,'UPDATE products SET category_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE category_id=?',rid),stmt(env,'UPDATE media_assets SET category_id=NULL WHERE category_id=?',rid),stmt(env,'DELETE FROM categories WHERE id=?',rid)]); return json({ok:true,permanent:true}); } if(name==='categories'){ await run(env,'UPDATE products SET category_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE category_id=?',rid); await run(env,'UPDATE categories SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?',rid); } else { await run(env,`UPDATE ${cfg.table} SET active=0 WHERE id=?`,rid); } return json({ok:true}); }
      const b=await parse(request);
      const cleaned=await cleanCollection(env,name,b,false); if(cleaned.error) return json({error:cleaned.error},400);
      const data=cleaned.data;
      if(name==='categories'&&data.name) { const dup=await first(env,'SELECT id FROM categories WHERE name=? COLLATE NOCASE AND active=1 AND id!=?',data.name,rid); if(dup) return json({error:'Ya existe otra categoría activa con ese nombre.'},409); }
      const cols=Object.keys(data);
      if(cols.length) {
        const set=cols.map(f=>`${f}=?`).join(',')+(HAS_UPDATED_AT.has(name)?',updated_at=CURRENT_TIMESTAMP':'');
        try { await run(env,`UPDATE ${cfg.table} SET ${set} WHERE id=?`,...cols.map(f=>data[f]),rid); }
        catch(e) { if(/UNIQUE/i.test(String(e?.message||e))) return json({error:'Ya existe un cupón con ese código.'},409); throw e; }
      }
      if(name==='products'&&Array.isArray(b.gallery_media_ids)){await run(env,'DELETE FROM product_images WHERE product_id=? AND is_primary=0',rid);let order=0;for(const mediaId of b.gallery_media_ids){if(!mediaId)continue;await run(env,'INSERT OR IGNORE INTO product_images(id,product_id,media_id,sort_order,is_primary) VALUES(?,?,?,?,?)',id('pimg_'),rid,String(mediaId),order++,0);}}
      return json({ok:true});
    }
  }
  if(path==='/api/admin/orders' && method==='GET') return json(await all(env,`SELECT o.*,c.name AS customer_name,c.phone FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 1000`));
  if(path.startsWith('/api/admin/orders/') && method==='PATCH') { const b=await parse(request); const r=await changeOrderStatus(env,decodeURIComponent(path.split('/').pop()),String(b.status||'pending')); return r.error?json({error:r.error},r.code):json({ok:true}); }
  if(path==='/api/admin/leads' && method==='GET') return json(await all(env,'SELECT * FROM leads ORDER BY created_at DESC LIMIT 1000'));
  if(path.startsWith('/api/admin/leads/') && method==='PATCH') { const b=await parse(request), st=String(b.status||'new'); if(!['new','contacted','closed'].includes(st)) return json({error:'Estado no válido.'},400); await run(env,'UPDATE leads SET status=? WHERE id=?',st,decodeURIComponent(path.split('/').pop())); return json({ok:true}); }
  if(path==='/api/admin/customers' && method==='GET') return json(await all(env,'SELECT * FROM customers ORDER BY created_at DESC LIMIT 1000'));
  if(path==='/api/admin/media' && method==='GET') return json(await all(env,`SELECT m.*,c.name AS category_name FROM media_assets m LEFT JOIN categories c ON c.id=m.category_id ORDER BY m.created_at DESC`));
  if(path==='/api/admin/media' && method==='POST') {
    const declared=(request.headers.get('Content-Type')||'application/octet-stream').split(';')[0].trim().toLowerCase();
    let fileName=''; try { fileName=decodeURIComponent(request.headers.get('X-File-Name')||'archivo'); } catch { fileName='archivo'; }
    let categoryId=nullIfEmpty(request.headers.get('X-Category-ID'));
    const published=flag(request.headers.get('X-Published'),1);
    if(!ALLOWED_UPLOADS.includes(declared)) return json({error:'Tipo de archivo no permitido.'},415);
    if(Number(request.headers.get('Content-Length')||0)>MAX_UPLOAD) return json({error:'Máximo 20 MB.'},413);
    const body=await request.arrayBuffer();
    if(!body.byteLength) return json({error:'El archivo está vacío.'},400);
    if(body.byteLength>MAX_UPLOAD) return json({error:'Máximo 20 MB.'},413);
    const sniffed=sniffType(new Uint8Array(body.slice(0,16)));
    if(sniffed!==declared) return json({error:'El contenido del archivo no coincide con su formato.'},415);
    if(categoryId&&!(await first(env,'SELECT id FROM categories WHERE id=?',categoryId))) categoryId=null;
    const safeName=fileName.replace(/[^a-zA-Z0-9._-]/g,'_').replace(/^\.+/,'').slice(-100)||'archivo';
    const key=`${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}-${safeName}`;
    await env.MEDIA.put(key,body,{httpMetadata:{contentType:declared}}); const urlMedia=mediaUrl(env,key), mediaId=id('med_');
    const maxOrder=categoryId?(await first(env,'SELECT COALESCE(MAX(sort_order),0) AS n FROM media_assets WHERE category_id=?',categoryId))?.n||0:0;
    await run(env,'INSERT INTO media_assets(id,object_key,public_url,filename,content_type,size_bytes,category_id,published,sort_order) VALUES(?,?,?,?,?,?,?,?,?)',mediaId,key,urlMedia,fileName.slice(0,200),declared,body.byteLength,categoryId,published,maxOrder+1);
    return json({id:mediaId,object_key:key,url:urlMedia,public_url:urlMedia,filename:fileName,content_type:declared,size_bytes:body.byteLength,category_id:categoryId,published},201);
  }
  if(path==='/api/admin/media/reorder' && method==='POST') {
    const b=await parse(request), ids=Array.isArray(b.ids)?b.ids.slice(0,500).map(String):[];
    if(!ids.length) return json({error:'Lista vacía.'},400);
    await env.DB.batch(ids.map((mid,i)=>stmt(env,'UPDATE media_assets SET sort_order=? WHERE id=?',i+1,mid)));
    return json({ok:true});
  }
  if(path.startsWith('/api/admin/media/') && method==='PATCH') {
    const mid=decodeURIComponent(path.split('/').pop()), b=await parse(request), sets=[], vals=[];
    if(!(await first(env,'SELECT id FROM media_assets WHERE id=?',mid))) return json({error:'Archivo no encontrado.'},404);
    if(b.category_id!==undefined) { const cid=nullIfEmpty(b.category_id); if(cid&&!(await first(env,'SELECT id FROM categories WHERE id=?',String(cid)))) return json({error:'La categoría no existe.'},400); sets.push('category_id=?'); vals.push(cid); }
    if(b.published!==undefined) { sets.push('published=?'); vals.push(flag(b.published)); }
    if(b.title!==undefined) { sets.push('title=?'); vals.push(String(b.title||'').slice(0,120)||null); }
    if(b.alt_text!==undefined) { sets.push('alt_text=?'); vals.push(String(b.alt_text||'').slice(0,200)||null); }
    if(b.sort_order!==undefined) { sets.push('sort_order=?'); vals.push(safeInt(b.sort_order,0)); }
    if(sets.length) await run(env,`UPDATE media_assets SET ${sets.join(',')} WHERE id=?`,...vals,mid);
    return json({ok:true});
  }
  if(path.startsWith('/api/admin/media/') && method==='DELETE') { const mid=decodeURIComponent(path.split('/').pop()), m=await first(env,'SELECT object_key,public_url FROM media_assets WHERE id=?',mid); if(!m) return json({error:'Archivo no encontrado.'},404); if(m.public_url) { await run(env,'UPDATE products SET image_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE image_url=?',m.public_url); await run(env,'UPDATE products SET video_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE video_url=?',m.public_url); await run(env,'UPDATE categories SET image_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE image_url=?',m.public_url); await run(env,'UPDATE banners SET video_url=NULL WHERE video_url=?',m.public_url); await run(env,'UPDATE popups SET video_url=NULL WHERE video_url=?',m.public_url); } await run(env,'UPDATE banners SET media_id=NULL WHERE media_id=?',mid); await run(env,'UPDATE popups SET media_id=NULL WHERE media_id=?',mid); await run(env,'UPDATE categories SET media_id=NULL WHERE media_id=?',mid); await run(env,'DELETE FROM product_images WHERE media_id=?',mid); try { await env.MEDIA.delete(m.object_key); } catch(e) { console.error(JSON.stringify({event:'r2_delete_failed',key:m.object_key,message:String(e?.message||e)})); } await run(env,'DELETE FROM media_assets WHERE id=?',mid); return json({ok:true}); }

  // ── Códigos de acceso del cliente (requieren DEVELOPER_KEY) ──
  if(developerRoute) {
    const denied=await devAuth(request,env); if(denied) return denied;
    if(path==='/api/admin/access-codes' && method==='GET') {
      const rows=await all(env,'SELECT id,slot,label,code_ciphertext,code_iv,created_at FROM access_codes WHERE active=1 AND slot BETWEEN 1 AND 3 ORDER BY slot');
      const slots=[];
      for(let slot=1;slot<=3;slot++) {
        const row=rows.find(x=>x.slot===slot);
        let code=null;
        if(row?.code_ciphertext&&row?.code_iv) {
          try { code=await decryptAccessCode(row.code_ciphertext,row.code_iv,env.DEVELOPER_KEY); }
          catch { return json({error:'No se pudo recuperar un código. Comprueba que DEVELOPER_KEY no haya cambiado desde su creación.'},500); }
        }
        slots.push({slot,id:row?.id||null,label:row?.label||('Cliente '+slot),code,created_at:row?.created_at||null,active:!!row});
      }
      return json({slots});
    }
    if(path==='/api/admin/access-codes' && method==='POST') {
      const b=await parse(request), slot=Number(b.slot);
      if(!Number.isInteger(slot)||slot<1||slot>3) return json({error:'El espacio debe ser 1, 2 o 3.'},400);
      const code=generateEightDigitCode(), cid=id('access_'), label='Cliente '+slot;
      const encrypted=await encryptAccessCode(code,env.DEVELOPER_KEY);
      await env.DB.batch([
        stmt(env,'UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE slot=? AND active=1',slot),
        stmt(env,'INSERT INTO access_codes(id,code_hash,label,active,expires_at,slot,code_ciphertext,code_iv) VALUES(?,?,?,1,NULL,?,?,?)',cid,await sha256(code),label,slot,encrypted.code_ciphertext,encrypted.code_iv)
      ]);
      const active=await first(env,'SELECT COUNT(DISTINCT slot) AS n FROM access_codes WHERE active=1 AND slot BETWEEN 1 AND 3');
      if((active?.n||0)>=3) await run(env,'UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE slot IS NULL AND active=1');
      return json({id:cid,slot,access_code:code},201);
    }
    if(path.startsWith('/api/admin/access-codes/slot/') && path.endsWith('/revoke') && method==='POST') {
      const slot=Number(path.split('/').slice(-2)[0]);
      if(!Number.isInteger(slot)||slot<1||slot>3) return json({error:'Espacio inválido.'},400);
      await run(env,'UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE slot=? AND active=1',slot);
      return json({ok:true,slot});
    }
    if(path==='/api/admin/access-codes/client-initial/revoke' && method==='POST') { await run(env,"UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE id='client-initial'"); return json({ok:true}); }
    if(path.startsWith('/api/admin/access-codes/') && path.endsWith('/revoke') && method==='POST') { const cid=path.split('/').slice(-2)[0]; await run(env,'UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE id=?',cid); return json({ok:true}); }
  }
  return null;
}

export default {
 async fetch(request,env,ctx) {
  const cors=corsHeaders(request); if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  try {
   const url=new URL(request.url);
   if(url.pathname.startsWith('/media/') && (request.method==='GET'||request.method==='HEAD')) return await serveMedia(request,env,url,cors);
   const pub=await publicApi(request,env,url); if(pub) { const h=new Headers(pub.headers); for(const [k,v] of Object.entries(cors)) h.set(k,v); return new Response(pub.body,{status:pub.status,headers:h}); }
   const admin=await adminApi(request,env,url,ctx); if(admin) { const h=new Headers(admin.headers); for(const [k,v] of Object.entries(cors)) h.set(k,v); h.set('cache-control','no-store'); return new Response(admin.body,{status:admin.status,headers:h}); }
   return json({error:'Ruta no encontrada.'},404,cors);
  } catch(e) { console.error(JSON.stringify({event:'pcx_api_error',path:new URL(request.url).pathname,method:request.method,message:String(e?.message||e)})); return json({error:'Error interno del servicio.',detail:env.ENVIRONMENT==='development'?String(e.message):undefined},500,cors); }
 }
};
