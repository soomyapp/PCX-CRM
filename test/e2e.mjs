// Prueba end-to-end del Worker sin red: D1 simulado con node:sqlite (SQL real) y R2 en memoria.
// Uso:  node --no-warnings test/e2e.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

import { makeD1, makeR2 } from './shim.mjs';

const DB = makeD1();
for (const f of ['0001_schema','0002_client_access_code_slots','0003_gallery_metrics']) DB.exec(readFileSync(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8'));
const MEDIA = makeR2();
const env = { DB, MEDIA, DEVELOPER_KEY: 'dev-key-test-123', PUBLIC_API_URL: 'https://api.test', ENVIRONMENT: 'development' };

let ipN = 0;
async function call(method, path, { body, token, raw, type, ip, headers = {} } = {}) {
  const h = { 'cf-connecting-ip': ip || `10.0.0.${++ipN}`, origin: 'https://corporacionpcx.pages.dev', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let b;
  if (raw !== undefined) { b = raw; h['content-type'] = type; } else if (body !== undefined) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await worker.fetch(new Request('https://api.test' + path, { method, headers: h, body: b }), env, { waitUntil: (p) => p });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, res, data: ct.includes('json') ? await res.json() : null };
}
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0,3).join('\n    ')); process.exitCode = 1; } };
const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(200,1)]);
const JPG = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(200,2)]);
const MP4 = Buffer.concat([Buffer.from([0,0,0,0x18]), Buffer.from('ftypmp42'), Buffer.alloc(300,3)]);
const up = (tok, buf, type, name, cat, pub) => call('POST','/api/admin/media',{token:tok,raw:buf,type,headers:{'x-file-name':encodeURIComponent(name),...(cat?{'x-category-id':cat}:{}),...(pub!==undefined?{'x-published':String(pub)}:{})}});

console.log('\nPCX · pruebas end-to-end (Worker actualizado)\n');
let tok, slot1, cat, cat2, prod, prod2, mediaA, mediaB, mediaV, orderId;

console.log('Acceso');
await t('salud: base, bucket y migración 0003', async () => { const r = await call('GET','/api/health'); assert.equal(r.status,200); assert.equal(r.data.media,'ok'); assert.equal(r.data.gallery,'ok'); });
await t('admin sin sesión → 401', async () => assert.equal((await call('GET','/api/admin/metrics')).status,401));
await t('DEVELOPER_KEY incorrecta → 403', async () => assert.equal((await call('POST','/api/admin/access-codes',{body:{slot:1},headers:{'x-developer-key':'x'}})).status,403));
await t('genera PIN de 8 dígitos en espacio 1', async () => { const r = await call('POST','/api/admin/access-codes',{body:{slot:1},headers:{'x-developer-key':env.DEVELOPER_KEY}}); assert.equal(r.status,201); assert.match(r.data.access_code,/^\d{8}$/); slot1=r.data.access_code; });
await t('recupera el PIN descifrado', async () => { const r = await call('GET','/api/admin/access-codes',{headers:{'x-developer-key':env.DEVELOPER_KEY}}); assert.equal(r.data.slots[0].code,slot1); });
await t('login con PIN → token', async () => { const r = await call('POST','/api/admin/login',{body:{code:slot1}}); assert.equal(r.status,200); tok=r.data.token; });
await t('restablecer PIN invalida el anterior', async () => {
  const r2 = await call('POST','/api/admin/access-codes',{body:{slot:1},headers:{'x-developer-key':env.DEVELOPER_KEY}}); assert.notEqual(r2.data.access_code,slot1);
  assert.equal((await call('POST','/api/admin/login',{body:{code:slot1}})).status,401);
  const ok = await call('POST','/api/admin/login',{body:{code:r2.data.access_code}}); assert.equal(ok.status,200); tok=ok.data.token;
});
await t('bloqueo tras 10 intentos fallidos', async () => { for(let i=0;i<10;i++) await call('POST','/api/admin/login',{body:{code:'00000000'},ip:'9.9.9.9'}); assert.equal((await call('POST','/api/admin/login',{body:{code:'00000000'},ip:'9.9.9.9'})).status,429); });
await t('CORS permite PUT', async () => { const r = await call('OPTIONS','/api/admin/settings'); assert.match(r.res.headers.get('access-control-allow-methods'),/PUT/); });

console.log('Categorías, productos y precios');
await t('crear categoría', async () => { const r = await call('POST','/api/admin/categories',{token:tok,body:{name:'Electrónica',description:'Gadgets'}}); assert.equal(r.status,201); cat=r.data.id; const r2 = await call('POST','/api/admin/categories',{token:tok,body:{name:'Energía solar'}}); cat2=r2.data.id; });
await t('categoría duplicada → 409', async () => assert.equal((await call('POST','/api/admin/categories',{token:tok,body:{name:'electrónica'}})).status,409));
await t('crear producto con precio', async () => { const r = await call('POST','/api/admin/products',{token:tok,body:{name:'Auriculares',sku:'AUR-1',category_id:cat,price_cents:2550,stock_qty:5,active:true,featured:true}}); assert.equal(r.status,201); prod=r.data.id; const r2 = await call('POST','/api/admin/products',{token:tok,body:{name:'Auriculares',price_cents:1000,stock_qty:1,category_id:cat2}}); assert.equal(r2.status,201); prod2=r2.data.id; });
await t('nombre repetido genera slug único (no falla)', async () => { const rows = await DB.prepare('SELECT slug FROM products').all(); assert.equal(new Set(rows.results.map(x=>x.slug)).size,2); });
await t('precio negativo → 400', async () => assert.equal((await call('POST','/api/admin/products',{token:tok,body:{name:'X',price_cents:-5}})).status,400));
await t('catálogo público muestra producto y categoría', async () => { const r = await call('GET','/api/catalog'); const p=r.data.products.find(x=>x.id===prod); assert.equal(p.price,25.5); assert.equal(p.category_name,'Electrónica'); assert.ok(r.data.categories.find(c=>c.id===cat)); assert.equal(r.res.headers.get('cache-control'),'no-cache'); });
await t('modificar precio se refleja en la web', async () => { assert.equal((await call('PATCH','/api/admin/products/'+prod,{token:tok,body:{price_cents:3100}})).status,200); const r = await call('GET','/api/catalog'); assert.equal(r.data.products.find(x=>x.id===prod).price,31); });
await t('cambiar producto de categoría', async () => { await call('PATCH','/api/admin/products/'+prod2,{token:tok,body:{category_id:cat}}); const r = await call('GET','/api/catalog'); assert.equal(r.data.products.find(x=>x.id===prod2).category_name,'Electrónica'); });
await t('categoría inexistente → 400', async () => assert.equal((await call('PATCH','/api/admin/products/'+prod,{token:tok,body:{category_id:'nope'}})).status,400));
await t('desactivar producto lo oculta', async () => { await call('DELETE','/api/admin/products/'+prod2,{token:tok}); const r = await call('GET','/api/catalog'); assert.ok(!r.data.products.find(x=>x.id===prod2)); });

console.log('Galería por categoría (R2)');
await t('formato falso (PNG declarado, contenido JPG) → 415', async () => assert.equal((await up(tok,JPG,'image/png','x.png',cat)).status,415));
await t('tipo no permitido (svg) → 415', async () => assert.equal((await up(tok,Buffer.from('<svg/>'),'image/svg+xml','x.svg',cat)).status,415));
await t('subir foto y video a la categoría', async () => {
  const a=await up(tok,PNG,'image/png','foto uno.png',cat); assert.equal(a.status,201); mediaA=a.data;
  const b=await up(tok,JPG,'image/jpeg','foto2.jpg',cat); assert.equal(b.status,201); mediaB=b.data;
  const v=await up(tok,MP4,'video/mp4','clip.mp4',cat); assert.equal(v.status,201); mediaV=v.data;
  assert.equal(MEDIA.store.size,3);
});
await t('lo subido a la categoría aparece en /api/catalog (gallery)', async () => {
  const r = await call('GET','/api/catalog'); const c=r.data.categories.find(x=>x.id===cat);
  assert.equal(c.gallery.length,3); assert.equal(r.data.gallery.length,3);
  assert.deepEqual(c.gallery.map(g=>g.type).sort(),['image','image','video']); assert.equal(c.gallery[0].category_name,'Electrónica');
});
await t('foto sin categoría NO aparece en la galería', async () => { await up(tok,PNG,'image/png','suelta.png'); const r=await call('GET','/api/catalog'); assert.equal(r.data.gallery.length,3); });
await t('ocultar (despublicar) una foto la quita de la web', async () => { await call('PATCH','/api/admin/media/'+mediaB.id,{token:tok,body:{published:false}}); const r=await call('GET','/api/catalog'); assert.equal(r.data.gallery.length,2); assert.ok(!r.data.gallery.find(g=>g.id===mediaB.id)); await call('PATCH','/api/admin/media/'+mediaB.id,{token:tok,body:{published:true}}); });
await t('subir con X-Published:0 queda oculta', async () => { const x=await up(tok,PNG,'image/png','oculta.png',cat,0); const r=await call('GET','/api/catalog'); assert.ok(!r.data.gallery.find(g=>g.id===x.data.id)); await call('DELETE','/api/admin/media/'+x.data.id,{token:tok}); });
await t('reordenar la galería', async () => { await call('POST','/api/admin/media/reorder',{token:tok,body:{ids:[mediaV.id,mediaB.id,mediaA.id]}}); const r=await call('GET','/api/catalog'); assert.deepEqual(r.data.gallery.map(g=>g.id),[mediaV.id,mediaB.id,mediaA.id]); });
await t('mover foto a otra categoría', async () => { await call('PATCH','/api/admin/media/'+mediaA.id,{token:tok,body:{category_id:cat2}}); const r=await call('GET','/api/catalog'); assert.equal(r.data.categories.find(c=>c.id===cat2).gallery.length,1); assert.equal(r.data.categories.find(c=>c.id===cat).gallery.length,2); });
await t('portada de categoría desde una foto', async () => { await call('PATCH','/api/admin/categories/'+cat,{token:tok,body:{media_id:mediaB.id}}); const r=await call('GET','/api/catalog'); assert.equal(r.data.categories.find(c=>c.id===cat).image_url,mediaB.url); });
await t('categoría desactivada oculta su galería', async () => { await call('DELETE','/api/admin/categories/'+cat2,{token:tok}); const r=await call('GET','/api/catalog'); assert.ok(!r.data.gallery.find(g=>g.id===mediaA.id)); await call('POST','/api/admin/categories',{token:tok,body:{name:'Energía solar'}}); });
await t('servir /media con caché inmutable', async () => { const path=new URL(mediaB.url).pathname; const r=await call('GET',path); assert.equal(r.status,200); assert.match(r.res.headers.get('cache-control'),/immutable/); assert.equal(r.res.headers.get('content-type'),'image/jpeg'); });
await t('Range → 206 con Content-Range', async () => { const path=new URL(mediaV.url).pathname; const r=await call('GET',path,{headers:{range:'bytes=0-99'}}); assert.equal(r.status,206); assert.match(r.res.headers.get('content-range'),/^bytes 0-99\/\d+$/); });
await t('clave de media inválida → 404', async () => { assert.equal((await call('GET','/media/not-a-key')).status,404); });
await t('eliminar foto la borra de R2 y de la web', async () => { const before=MEDIA.store.size; assert.equal((await call('DELETE','/api/admin/media/'+mediaV.id,{token:tok})).status,200); assert.equal(MEDIA.store.size,before-1); const r=await call('GET','/api/catalog'); assert.ok(!r.data.gallery.find(g=>g.id===mediaV.id)); });

console.log('Promociones, pop-ups y cupones');
await t('crear banner y verlo en la web', async () => { const m=await up(tok,JPG,'image/jpeg','ban.jpg'); const r=await call('POST','/api/admin/banners',{token:tok,body:{title:'Black Friday',position:'hero',media_id:m.data.id,active:true}}); assert.equal(r.status,201); const c=await call('GET','/api/catalog'); const b=c.data.banners.find(x=>x.title==='Black Friday'); assert.equal(b.position,'hero'); assert.equal(b.image_url,m.data.url); });
await t('banner con enlace javascript: → 400', async () => assert.equal((await call('POST','/api/admin/banners',{token:tok,body:{title:'x',link_url:'javascript:alert(1)'}})).status,400));
await t('crear pop-up y verlo en la web', async () => { const r=await call('POST','/api/admin/popups',{token:tok,body:{title:'-10%',body:'Hoy',trigger_type:'delay',trigger_value:'Después de 8 segundos',active:true}}); assert.equal(r.status,201); const c=await call('GET','/api/catalog'); assert.equal(c.data.popups[0].title,'-10%'); });
await t('pausar pop-up lo retira', async () => { const c=await call('GET','/api/catalog'); await call('PATCH','/api/admin/popups/'+c.data.popups[0].id,{token:tok,body:{active:false}}); assert.equal((await call('GET','/api/catalog')).data.popups.length,0); });
await t('cupón: crear, validar y PATCH', async () => {
  const r=await call('POST','/api/admin/coupons',{token:tok,body:{code:'pcx10',discount_type:'percent',discount_value:10,min_order_cents:0}}); assert.equal(r.status,201);
  assert.equal((await call('POST','/api/admin/coupons',{token:tok,body:{code:'PCX10',discount_type:'percent',discount_value:5}})).status,409);
  assert.equal((await call('POST','/api/admin/coupons',{token:tok,body:{code:'BAD',discount_type:'percent',discount_value:500}})).status,400);
  const v=await call('POST','/api/coupons/validate',{body:{code:'PCX10',subtotal_cents:10000}}); assert.equal(v.data.discount_cents,1000);
  await call('PATCH','/api/admin/coupons/'+r.data.id,{token:tok,body:{discount_value:20}}); assert.equal((await call('POST','/api/coupons/validate',{body:{code:'PCX10',subtotal_cents:10000}})).data.discount_cents,2000);
});

console.log('Pedidos, inventario y métricas');
await t('pedido: precio y stock los decide el servidor', async () => { const r=await call('POST','/api/orders',{body:{customer:{name:'Ana',phone:'0412'},items:[{product_id:prod,quantity:2,price:1}],coupon_code:'PCX10'}}); assert.equal(r.status,201); assert.equal(r.data.subtotal_cents,6200); assert.equal(r.data.discount_cents,1240); assert.equal(r.data.total_cents,4960); orderId=r.data.id; assert.equal((await DB.prepare('SELECT stock_qty FROM products WHERE id=?').bind(prod).first()).stock_qty,3); });
await t('stock insuficiente → 400', async () => assert.equal((await call('POST','/api/orders',{body:{customer:{name:'B',phone:'1'},items:[{product_id:prod,quantity:50}]}})).status,400));
await t('cupón inválido en pedido → 400 (no descuento silencioso)', async () => assert.equal((await call('POST','/api/orders',{body:{customer:{name:'B',phone:'1'},items:[{product_id:prod,quantity:1}],coupon_code:'NOPE'}})).status,400));
await t('mismo teléfono reutiliza cliente', async () => { await call('POST','/api/orders',{body:{customer:{name:'Ana',phone:'0412'},items:[{product_id:prod,quantity:1}]}}); assert.equal((await DB.prepare("SELECT COUNT(*) n FROM customers WHERE phone='0412'").first()).n,1); });
await t('pedido pendiente no cuenta como venta', async () => { const m=await call('GET','/api/admin/metrics?days=30',{token:tok}); assert.equal(m.data.totals.sales_cents,0); assert.ok(m.data.totals.pending_orders>=2); });
await t('confirmar pedido → entra en métricas', async () => { assert.equal((await call('PATCH','/api/admin/orders/'+orderId,{token:tok,body:{status:'confirmed'}})).status,200); const m=await call('GET','/api/admin/metrics?days=30',{token:tok}); assert.equal(m.data.totals.sales_cents,4960); assert.equal(m.data.totals.orders,1); assert.equal(m.data.totals.units,2); assert.equal(m.data.top_products[0].name,'Auriculares'); assert.equal(m.data.by_category[0].category,'Electrónica'); assert.equal(m.data.daily.length,30); assert.equal(m.data.daily.reduce((s,d)=>s+d.sales_cents,0),4960); });
await t('estado inválido → 400', async () => assert.equal((await call('PATCH','/api/admin/orders/'+orderId,{token:tok,body:{status:'hackeado'}})).status,400));
await t('cancelar devuelve stock y cupón', async () => { const before=(await DB.prepare('SELECT stock_qty FROM products WHERE id=?').bind(prod).first()).stock_qty; await call('PATCH','/api/admin/orders/'+orderId,{token:tok,body:{status:'cancelled'}}); assert.equal((await DB.prepare('SELECT stock_qty FROM products WHERE id=?').bind(prod).first()).stock_qty,before+2); const m=await call('GET','/api/admin/metrics?days=30',{token:tok}); assert.equal(m.data.totals.sales_cents,0); });
await t('límite de pedidos por IP → 429', async () => { let last; for(let i=0;i<22;i++) last=await call('POST','/api/orders',{body:{customer:{name:'x',phone:'1'},items:[{product_id:'zz',quantity:1}]},ip:'7.7.7.7'}); assert.equal(last.status,429); });

console.log('Configuración');
await t('PUT settings: WhatsApp visible en el catálogo', async () => { const r=await call('PUT','/api/admin/settings',{token:tok,body:{whatsapp:'+58 424-4656724',store_name:'PCX',hack:'x'}}); assert.equal(r.status,200); const c=await call('GET','/api/catalog'); assert.equal(c.data.settings.whatsapp,'584244656724'); assert.equal(c.data.settings.hack,undefined); });
await t('WhatsApp inválido → 400', async () => assert.equal((await call('PUT','/api/admin/settings',{token:tok,body:{whatsapp:'12'}})).status,400));
await t('logout cierra la sesión', async () => { await call('POST','/api/admin/logout',{token:tok,body:{}}); assert.equal((await call('GET','/api/admin/products',{token:tok})).status,401); });
console.log(`\n${passed} pruebas OK${process.exitCode?' — HAY FALLOS':''}\n`);
