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
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = origin === 'https://corporacionpcx.pages.dev' || origin === 'https://corporacionpcx.com' || origin === 'https://www.corporacionpcx.com' || /^https:\/\/[a-z0-9-]+\.corporacionpcx\.pages\.dev$/i.test(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return { 'access-control-allow-origin': allowed ? origin : 'https://corporacionpcx.pages.dev', 'vary':'Origin', 'access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers':'Content-Type,Authorization,X-File-Name,X-Category-ID,X-Developer-Key', 'access-control-max-age':'86400' };
}
const mediaUrl = (env, key) => `${env.PUBLIC_API_URL || 'https://pcx-crm-api.lcreativo.workers.dev'}/media/${key}`;
async function requireAdmin(request, env) {
  const token = (request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
  if (!token) return null;
  const tokenHash = await sha256(token);
  return await first(env, `SELECT s.id,s.user_id,s.expires_at,u.username,u.role FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, tokenHash, now());
}
async function createOrder(env, body) {
  const customer = body.customer || {};
  const name = String(customer.name||'').trim();
  const phone = String(customer.phone||'').trim();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!name || !phone || !items.length) throw new Error('Faltan datos del cliente o productos.');
  const normalized=[]; let subtotal=0;
  for (const item of items) {
    const product = await first(env,'SELECT id,name,price_cents,stock_qty,active FROM products WHERE id=?',String(item.product_id));
    const qty = Math.max(1, Math.min(100, safeInt(item.quantity,1)));
    if (!product || !product.active) throw new Error('Uno de los productos no está disponible.');
    if (product.stock_qty < qty) throw new Error(`Stock insuficiente para ${product.name}.`);
    const line = product.price_cents * qty; subtotal += line;
    normalized.push({product_id:product.id,name:product.name,quantity:qty,unit_price_cents:product.price_cents,line_total_cents:line});
  }
  let discount=0, couponCode=null;
  if (body.coupon_code) {
    const c=await first(env,'SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND active=1',String(body.coupon_code).trim());
    if (c && inWindow(c.starts_at,c.ends_at) && (!c.usage_limit||c.used_count<c.usage_limit) && subtotal>=c.min_order_cents) {
      discount=c.discount_type==='percent' ? Math.round(subtotal*c.discount_value/100) : Math.min(subtotal,c.discount_value);
      couponCode=c.code;
    }
  }
  const customerId=id('cus_'), orderId=id('ord_'), orderNumber='PCX-'+Date.now().toString(36).toUpperCase();
  const statements=[
    stmt(env,'INSERT INTO customers(id,name,phone) VALUES(?,?,?)',customerId,name,phone),
    stmt(env,'INSERT INTO orders(id,customer_id,order_number,status,subtotal_cents,discount_cents,total_cents,coupon_code,shipping_json,items_json) VALUES(?,?,?,\'pending\',?,?,?,?,?,?)',orderId,customerId,orderNumber,subtotal,discount,subtotal-discount,couponCode,JSON.stringify(body.shipping||{}),JSON.stringify(normalized))
  ];
  for (const p of normalized) statements.push(stmt(env,'UPDATE products SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock_qty>=?',p.quantity,p.product_id,p.quantity));
  if (couponCode) statements.push(stmt(env,'UPDATE coupons SET used_count=used_count+1 WHERE code=?',couponCode));
  const results=await env.DB.batch(statements);
  if (results.some(r=>r.success===false)) throw new Error('No se pudo registrar el pedido.');
  const stockResults=results.slice(2,2+normalized.length);
  if (stockResults.some(r=>(r.meta?.changes??1)!==1)) {
    const rollback=[]; normalized.forEach((p,i)=>{ if((stockResults[i]?.meta?.changes??1)===1) rollback.push(stmt(env,'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',p.quantity,p.product_id)); });
    rollback.push(stmt(env,'DELETE FROM orders WHERE id=?',orderId),stmt(env,'DELETE FROM customers WHERE id=?',customerId));
    if(couponCode) rollback.push(stmt(env,'UPDATE coupons SET used_count=MAX(0,used_count-1) WHERE code=?',couponCode));
    await env.DB.batch(rollback); throw new Error('El inventario cambió durante la compra. Intenta nuevamente.');
  }
  return {id:orderId,order_number:orderNumber,subtotal_cents:subtotal,discount_cents:discount,total_cents:subtotal-discount,status:'pending'};
}
async function publicApi(request, env, url) {
  if (url.pathname==='/api/health') {
    const db=await first(env,'SELECT COUNT(*) AS products FROM products');
    let bucket='ok'; try { await env.MEDIA.list({limit:1}); } catch { bucket='error'; }
    return json({ok:true,service:'pcx-crm-api',database:'ok',products:db?.products||0,media:bucket,time:now()});
  }
  if (url.pathname==='/api/catalog' && request.method==='GET') {
    const categories=await all(env,`SELECT c.*,COALESCE(m.public_url,c.image_url) AS image_url,m.content_type AS image_content_type FROM categories c LEFT JOIN media_assets m ON m.id=COALESCE(c.media_id,(SELECT ma.id FROM media_assets ma WHERE ma.category_id=c.id AND ma.content_type LIKE 'image/%' ORDER BY ma.created_at DESC LIMIT 1)) WHERE c.active=1 ORDER BY c.sort_order,c.name`);
    const products=await all(env,`SELECT p.*,c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=1 ORDER BY p.featured DESC,p.created_at DESC`);
    const productMedia=await all(env,`SELECT pi.product_id,pi.sort_order,pi.is_primary,m.id AS media_id,m.public_url,m.content_type,m.filename FROM product_images pi JOIN media_assets m ON m.id=pi.media_id ORDER BY pi.product_id,pi.is_primary DESC,pi.sort_order ASC`);
    const mediaByProduct=new Map(); for(const item of productMedia){if(!mediaByProduct.has(item.product_id))mediaByProduct.set(item.product_id,[]);mediaByProduct.get(item.product_id).push({id:item.media_id,url:item.public_url,type:String(item.content_type||'').startsWith('video/')?'video':'image',filename:item.filename,sort_order:item.sort_order,is_primary:!!item.is_primary});}
    const bannersAll=await all(env,`SELECT b.*,m.public_url AS image,m.content_type AS image_content_type FROM banners b LEFT JOIN media_assets m ON m.id=b.media_id WHERE b.active=1 ORDER BY b.sort_order`);
    const popupsAll=await all(env,`SELECT p.*,m.public_url AS image,m.content_type AS image_content_type FROM popups p LEFT JOIN media_assets m ON m.id=p.media_id WHERE p.active=1`);
    const normalizePosition=v=>{const x=String(v||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase();if(x.includes('hero')||x.includes('portada')||x==='home')return 'hero';if(x.includes('categor'))return 'category';if(x.includes('popup')||x.includes('pop-out')||x.includes('emergente'))return 'popup';return 'promotion';};
    const banners=bannersAll.filter(x=>inWindow(x.starts_at,x.ends_at)).map(x=>({...x,position:normalizePosition(x.position),image_url:x.image||null,media_type:String(x.image_content_type||'').startsWith('video/')?'video':x.video_url?'video':'image'}));
    const popups=popupsAll.filter(x=>inWindow(x.starts_at,x.ends_at)).map(x=>({...x,image_url:x.image||null}));
    return json({categories,products:products.map(p=>{const gallery=mediaByProduct.get(p.id)||[];return {...p,price:p.price_cents/100,image:p.image_url,image_url:p.image_url,images:gallery,media:[...(p.image_url?[{url:p.image_url,type:'image',is_primary:true}]:[]),...(p.video_url?[{url:p.video_url,type:'video'}]:[]),...gallery]};}),banners,popups});
  }
  if (url.pathname==='/api/coupons/validate' && request.method==='POST') {
    const b=await parse(request), code=String(b.code||'').trim().toUpperCase(), subtotal=Math.max(0,safeInt(b.subtotal_cents));
    const c=await first(env,'SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND active=1',code);
    if(!c) return json({valid:false,error:'Cupón no válido'},400);
    if(!inWindow(c.starts_at,c.ends_at)||(c.usage_limit&&c.used_count>=c.usage_limit)||subtotal<c.min_order_cents) return json({valid:false,error:'El cupón no está disponible para esta compra.'},400);
    const discount=c.discount_type==='percent'?Math.round(subtotal*c.discount_value/100):Math.min(subtotal,c.discount_value);
    return json({valid:true,code:c.code,discount_cents:discount});
  }
  if (url.pathname==='/api/leads' && request.method==='POST') {
    const b=await parse(request), name=String(b.name||'').trim(),phone=String(b.phone||'').trim(),topic=String(b.topic||'Consulta').trim();
    if(!name||!phone) return json({error:'Nombre y teléfono son obligatorios.'},400);
    const ticket='PCX-'+Date.now().toString(36).toUpperCase();
    await run(env,'INSERT INTO leads(id,ticket,name,phone,topic,message) VALUES(?,?,?,?,?,?)',id('lead_'),ticket,name,phone,topic,String(b.message||''));
    return json({ok:true,ticket},201);
  }
  if (url.pathname==='/api/orders' && request.method==='POST') {
    try { return json(await createOrder(env,await parse(request)),201); } catch(e) { return json({error:e.message||'No se pudo registrar el pedido.'},400); }
  }
  return null;
}
async function adminApi(request, env, url) {
  const path=url.pathname, method=request.method;
  if(path==='/api/admin/login' && method==='POST') {
    const ip=request.headers.get('CF-Connecting-IP')||'unknown', ipHash=await sha256(ip), since=new Date(Date.now()-15*60*1000).toISOString();
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
    return json({ok:true,token,expires_in:43200});
  }
  const developerRoute=path.startsWith('/api/admin/access-codes');
  const session=developerRoute?null:await requireAdmin(request,env);
  if(path.startsWith('/api/admin/') && path!=='/api/admin/login' && !developerRoute && !session) return json({error:'Sesión no válida o expirada.'},401);
  if(path==='/api/admin/logout' && method==='POST') { const token=(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,''); await run(env,'DELETE FROM admin_sessions WHERE token_hash=?',await sha256(token)); return json({ok:true}); }
  if(path==='/api/admin/overview' && method==='GET') {
    const row=await first(env,`SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM products WHERE active=1) AS products,(SELECT COUNT(*) FROM customers) AS customers,(SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status!='cancelled') AS revenue_cents`); return json(row||{});
  }
  if(path==='/api/admin/settings' && method==='GET') { const rows=await all(env,'SELECT key,value FROM store_settings'); return json(Object.fromEntries(rows.map(x=>[x.key,x.value]))); }
  if(path==='/api/admin/settings' && (method==='PATCH'||method==='POST'||method==='PUT')) { const b=await parse(request); for(const [k,v] of Object.entries(b)) await run(env,'INSERT INTO store_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',k,String(v)); return json({ok:true}); }
  const collections={
    products:{table:'products',fields:['category_id','name','slug','description','price_cents','compare_at_cents','sku','stock_qty','active','featured','video_url','image_url'], order:'created_at DESC'},
    categories:{table:'categories',fields:['name','slug','description','sort_order','active','media_id','image_url'],order:'sort_order,name'},
    coupons:{table:'coupons',fields:['code','discount_type','discount_value','min_order_cents','usage_limit','starts_at','ends_at','active'],order:'created_at DESC'},
    banners:{table:'banners',fields:['title','subtitle','media_id','link_url','position','active','starts_at','ends_at','sort_order','video_url'],order:'sort_order'},
    popups:{table:'popups',fields:['title','body','media_id','button_text','button_url','trigger_type','trigger_value','active','starts_at','ends_at','video_url'],order:'created_at DESC'}
  };
  for(const [name,cfg] of Object.entries(collections)) {
    const base='/api/admin/'+name;
    if(path===base && method==='GET') {
      let sql=`SELECT * FROM ${cfg.table} ORDER BY ${cfg.order}`;
      if(name==='categories') sql=`SELECT c.*,COALESCE(m.public_url,c.image_url) AS image_url,m.content_type AS image_content_type FROM categories c LEFT JOIN media_assets m ON m.id=COALESCE(c.media_id,(SELECT ma.id FROM media_assets ma WHERE ma.category_id=c.id AND ma.content_type LIKE 'image/%' ORDER BY ma.created_at DESC LIMIT 1)) ORDER BY c.sort_order,c.name`;
      if(name==='banners'||name==='popups') sql=`SELECT x.*,m.public_url AS image,m.content_type AS image_content_type FROM ${cfg.table} x LEFT JOIN media_assets m ON m.id=x.media_id ORDER BY x.${name==='banners'?'sort_order':'created_at'} ${name==='banners'?'ASC':'DESC'}`;
      if(name==='products') { const rows=await all(env,sql); const gallery=await all(env,`SELECT pi.product_id,pi.sort_order,pi.is_primary,m.id AS media_id,m.public_url,m.content_type,m.filename FROM product_images pi JOIN media_assets m ON m.id=pi.media_id ORDER BY pi.product_id,pi.is_primary DESC,pi.sort_order ASC`); const byProduct=new Map(); for(const item of gallery){if(!byProduct.has(item.product_id))byProduct.set(item.product_id,[]);byProduct.get(item.product_id).push({id:item.media_id,url:item.public_url,type:String(item.content_type||'').startsWith('video/')?'video':'image',sort_order:item.sort_order,is_primary:!!item.is_primary});} return json(rows.map(p=>({...p,images:byProduct.get(p.id)||[]}))); }
      return json(await all(env,sql));
    }
    if(path===base && method==='POST') {
      const b=await parse(request), data={...b};
      if(name==='products'){data.id=data.id||id('prd_');data.slug=data.slug||slug(data.name);data.price_cents=safeInt(data.price_cents);data.stock_qty=safeInt(data.stock_qty);}
      if(name==='categories') {
        const categoryName=String(data.name||'').trim();
        if(!categoryName) return json({error:'El nombre de la categoría es obligatorio.'},400);
        if(categoryName.length>60) return json({error:'El nombre no puede superar 60 caracteres.'},400);
        const baseSlug=slug(data.slug||categoryName);
        const existing=await first(env,'SELECT id,name,active FROM categories WHERE slug=? COLLATE NOCASE',baseSlug);
        if(existing) {
          if(String(existing.name||'').trim().toLowerCase()===categoryName.toLowerCase() && !existing.active) {
            await run(env,'UPDATE categories SET name=?,description=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?',categoryName,String(data.description||''),existing.id);
            return json({ok:true,id:existing.id,reactivated:true},200);
          }
          if(String(existing.name||'').trim().toLowerCase()===categoryName.toLowerCase() && existing.active)
            return json({error:'Ya existe una categoría activa con ese nombre.'},409);
          data.slug=baseSlug+'-'+crypto.randomUUID().slice(0,8);
        } else data.slug=baseSlug;
        data.id=data.id||id('cat_'); data.name=categoryName;
        try {
          await run(env,'INSERT INTO categories(id,name,slug,description,sort_order,active) VALUES(?,?,?,?,?,?)',data.id,data.name,data.slug,String(data.description||''),safeInt(data.sort_order,0),data.active===undefined?1:(data.active?1:0));
        } catch(error) {
          console.error(JSON.stringify({event:'category_create_failed',message:String(error?.message||error),slug:data.slug}));
          return json({error:'No se pudo crear la categoría. Comprueba que el nombre no esté repetido e inténtalo de nuevo.'},409);
        }
        return json({ok:true,id:data.id},201);
      }
      if(name==='coupons'){data.id=data.id||id('cpn_');data.code=String(data.code||'').toUpperCase();}
      if(name==='banners') data.id=data.id||id('ban_'); if(name==='popups') data.id=data.id||id('pop_');
      const fields=cfg.fields.filter(f=>data[f]!==undefined), cols=['id',...fields], vals=[data.id,...fields.map(f=>data[f])];
      await run(env,`INSERT INTO ${cfg.table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`,...vals);
      if(name==='products'&&Array.isArray(data.gallery_media_ids)){let order=0;for(const mediaId of data.gallery_media_ids){if(!mediaId)continue;await run(env,'INSERT OR IGNORE INTO product_images(id,product_id,media_id,sort_order,is_primary) VALUES(?,?,?,?,?)',id('pimg_'),data.id,String(mediaId),order++,0);}}
      return json({ok:true,id:data.id},201);
    }
    const prefix=base+'/'; if(path.startsWith(prefix) && (method==='PATCH'||method==='DELETE')) {
      const rid=decodeURIComponent(path.slice(prefix.length));
      if(method==='DELETE') { if(name==='categories'){ await run(env,'UPDATE products SET category_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE category_id=?',rid); await run(env,'UPDATE categories SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?',rid); } else { await run(env,`UPDATE ${cfg.table} SET active=0 WHERE id=?`,rid); } return json({ok:true}); }
      const b=await parse(request), fields=cfg.fields.filter(f=>b[f]!==undefined); if(!fields.length) return json({ok:true});
      await run(env,`UPDATE ${cfg.table} SET ${fields.map(f=>`${f}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`,...fields.map(f=>b[f]),rid).catch(async()=>run(env,`UPDATE ${cfg.table} SET ${fields.map(f=>`${f}=?`).join(',')} WHERE id=?`,...fields.map(f=>b[f]),rid));
      if(name==='products'&&Array.isArray(b.gallery_media_ids)){await run(env,'DELETE FROM product_images WHERE product_id=? AND is_primary=0',rid);let order=0;for(const mediaId of b.gallery_media_ids){if(!mediaId)continue;await run(env,'INSERT OR IGNORE INTO product_images(id,product_id,media_id,sort_order,is_primary) VALUES(?,?,?,?,?)',id('pimg_'),rid,String(mediaId),order++,0);}}
      return json({ok:true});
    }
  }
  if(path==='/api/admin/orders' && method==='GET') return json(await all(env,`SELECT o.*,c.name AS customer_name,c.phone FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`));
  if(path.startsWith('/api/admin/orders/') && method==='PATCH') { const b=await parse(request); await run(env,'UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',String(b.status||'pending'),decodeURIComponent(path.split('/').pop())); return json({ok:true}); }
  if(path==='/api/admin/leads' && method==='GET') return json(await all(env,'SELECT * FROM leads ORDER BY created_at DESC'));
  if(path.startsWith('/api/admin/leads/') && method==='PATCH') { const b=await parse(request); await run(env,'UPDATE leads SET status=? WHERE id=?',String(b.status||'new'),decodeURIComponent(path.split('/').pop())); return json({ok:true}); }
  if(path==='/api/admin/customers' && method==='GET') return json(await all(env,'SELECT * FROM customers ORDER BY created_at DESC'));
  if(path==='/api/admin/media' && method==='GET') return json(await all(env,`SELECT m.*,c.name AS category_name FROM media_assets m LEFT JOIN categories c ON c.id=m.category_id ORDER BY m.created_at DESC`));
  if(path==='/api/admin/media' && method==='POST') {
    const type=request.headers.get('Content-Type')||'application/octet-stream', fileName=decodeURIComponent(request.headers.get('X-File-Name')||'archivo'), categoryId=request.headers.get('X-Category-ID')||null;
    const body=await request.arrayBuffer(); if(body.byteLength>20*1024*1024) return json({error:'Máximo 20 MB.'},413);
    if(type==='image/svg+xml'){const svgText=new TextDecoder().decode(body);if(!/<svg[\s>]/i.test(svgText)||/<script|<foreignObject|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*['\"]\s*(?:https?:|javascript:|data:)/i.test(svgText))return json({error:'SVG no válido o contiene contenido activo. Usa un SVG vectorial seguro.'},400);}
    const allowed=['image/jpeg','image/png','image/webp','image/gif','image/avif','image/svg+xml','video/mp4','video/webm','application/pdf']; if(!allowed.includes(type)) return json({error:'Tipo de archivo no permitido.'},415);
    const key=`${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    await env.MEDIA.put(key,body,{httpMetadata:{contentType:type}}); const urlMedia=mediaUrl(env,key), mediaId=id('med_');
    await run(env,'INSERT INTO media_assets(id,object_key,public_url,filename,content_type,size_bytes,category_id) VALUES(?,?,?,?,?,?,?)',mediaId,key,urlMedia,fileName,type,body.byteLength,categoryId);
    return json({id:mediaId,object_key:key,url:urlMedia,public_url:urlMedia,filename:fileName,content_type:type,size_bytes:body.byteLength,category_id:categoryId},201);
  }
  if(path.startsWith('/api/admin/media/') && method==='PATCH') { const b=await parse(request); await run(env,'UPDATE media_assets SET category_id=? WHERE id=?',b.category_id||null,decodeURIComponent(path.split('/').pop())); return json({ok:true}); }
  if(path.startsWith('/api/admin/media/') && method==='DELETE') { const mid=decodeURIComponent(path.split('/').pop()), m=await first(env,'SELECT object_key,public_url FROM media_assets WHERE id=?',mid); if(m?.public_url) { await run(env,'UPDATE products SET image_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE image_url=?',m.public_url); await run(env,'UPDATE products SET video_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE video_url=?',m.public_url); await run(env,'UPDATE categories SET image_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE image_url=?',m.public_url); await run(env,'UPDATE banners SET video_url=NULL WHERE video_url=?',m.public_url); await run(env,'UPDATE popups SET video_url=NULL WHERE video_url=?',m.public_url); } await run(env,'UPDATE banners SET media_id=NULL WHERE media_id=?',mid); await run(env,'UPDATE popups SET media_id=NULL WHERE media_id=?',mid); await run(env,'UPDATE categories SET media_id=NULL WHERE media_id=?',mid); await run(env,'DELETE FROM product_images WHERE media_id=?',mid); if(m) await env.MEDIA.delete(m.object_key); await run(env,'DELETE FROM media_assets WHERE id=?',mid); return json({ok:true}); }
  if(path==='/api/admin/access-codes' && method==='GET') {
    const key=request.headers.get('X-Developer-Key')||'';
    if(!env.DEVELOPER_KEY||key!==env.DEVELOPER_KEY) return json({error:'No autorizado.'},403);
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
    const key=request.headers.get('X-Developer-Key')||'';
    if(!env.DEVELOPER_KEY||key!==env.DEVELOPER_KEY) return json({error:'No autorizado.'},403);
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
    const key=request.headers.get('X-Developer-Key')||'';
    if(!env.DEVELOPER_KEY||key!==env.DEVELOPER_KEY) return json({error:'No autorizado.'},403);
    const slot=Number(path.split('/').slice(-2)[0]);
    if(!Number.isInteger(slot)||slot<1||slot>3) return json({error:'Espacio inválido.'},400);
    await run(env,'UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE slot=? AND active=1',slot);
    return json({ok:true,slot});
  }
  if(path.startsWith('/api/admin/access-codes/') && path.endsWith('/revoke') && method==='POST') {
    const key=request.headers.get('X-Developer-Key')||''; if(!env.DEVELOPER_KEY||key!==env.DEVELOPER_KEY) return json({error:'No autorizado.'},403);
    const cid=path.split('/').slice(-2)[0]; await run(env,'UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE id=?',cid); return json({ok:true});
  }
  if(path==='/api/admin/access-codes/client-initial/revoke' && method==='POST') {
    const key=request.headers.get('X-Developer-Key')||''; if(!env.DEVELOPER_KEY||key!==env.DEVELOPER_KEY) return json({error:'No autorizado.'},403);
    await run(env,"UPDATE access_codes SET active=0,revoked_at=CURRENT_TIMESTAMP WHERE id='client-initial'"); return json({ok:true});
  }
  return null;
}
export default {
 async fetch(request,env,ctx) {
  const cors=corsHeaders(request); if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  try {
   const url=new URL(request.url);
   if(url.pathname.startsWith('/media/')) { const key=decodeURIComponent(url.pathname.slice(7)); const obj=await env.MEDIA.get(key); if(!obj) return new Response('Not found',{status:404,headers:cors}); const h=new Headers(cors); obj.writeHttpMetadata(h); h.set('etag',obj.httpEtag); return new Response(obj.body,{headers:h}); }
   const pub=await publicApi(request,env,url); if(pub) { const h=new Headers(pub.headers); for(const [k,v] of Object.entries(cors)) h.set(k,v); return new Response(pub.body,{status:pub.status,headers:h}); }
   const admin=await adminApi(request,env,url); if(admin) { const h=new Headers(admin.headers); for(const [k,v] of Object.entries(cors)) h.set(k,v); return new Response(admin.body,{status:admin.status,headers:h}); }
   return json({error:'Ruta no encontrada.'},404,cors);
  } catch(e) { console.error(JSON.stringify({event:'pcx_api_error',path:new URL(request.url).pathname,method:request.method,message:String(e?.message||e)})); return json({error:'Error interno del servicio.',detail:env.ENVIRONMENT==='development'?String(e.message):undefined},500,cors); }
 }
};
