import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const required = ['src/index.js','wrangler.jsonc','migrations/0001_schema.sql','migrations/0002_client_access_code_slots.sql','migrations/0003_gallery_metrics.sql','migrations/0004_product_variants.sql','public/index.html','public/crm-admin.html'];
for (const f of required) readFileSync(join(root,f));
execFileSync(process.execPath,['--check',join(root,'src/index.js')],{stdio:'inherit'});
const config = JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));
if (config.name !== 'pcx-crm-api' || !config.d1_databases?.some(x=>x.binding==='DB') || !config.r2_buckets?.some(x=>x.binding==='MEDIA')) throw new Error('wrangler.jsonc no contiene los bindings DB/MEDIA esperados.');
const migration = readFileSync(join(root,'migrations/0002_client_access_code_slots.sql'),'utf8');
for (const token of ['ADD COLUMN slot','ADD COLUMN code_ciphertext','ADD COLUMN code_iv','idx_access_codes_active_slot']) if (!migration.includes(token)) throw new Error(`Migración de accesos incompleta: falta ${token}.`);
const worker = readFileSync(join(root,'src/index.js'),'utf8');
const m3 = readFileSync(join(root,'migrations/0003_gallery_metrics.sql'),'utf8');
for (const token of ['ADD COLUMN published','ADD COLUMN sort_order','rate_limits']) if (!m3.includes(token)) throw new Error(`Migración 0003 incompleta: falta ${token}.`);
for (const token of ['/api/admin/metrics','sniffType','serveMedia','gallery']) if (!readFileSync(join(root,'src/index.js'),'utf8').includes(token)) throw new Error(`Worker incompleto: falta ${token}.`);
for (const token of ['generateEightDigitCode','encryptAccessCode','decryptAccessCode','/api/admin/access-codes/slot/']) if (!worker.includes(token)) throw new Error(`API de accesos incompleta: falta ${token}.`);
for (const file of ['public/index.html','public/crm-admin.html']) {
  const html=readFileSync(join(root,file),'utf8');
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m=>m[1]).filter(x=>x.trim());
  for (const [i,script] of scripts.entries()) {
    const tmp=join(tmpdir(),`pcx-${process.pid}-${i}.js`);
    try { writeFileSync(tmp,script); execFileSync(process.execPath,['--check',tmp],{stdio:'inherit'}); }
    finally { try { unlinkSync(tmp); } catch {} }
  }
  if (!html.includes('https://pcx-crm-api.lcreativo.workers.dev')) throw new Error(`${file} no apunta al Worker configurado.`);
  if (file === 'public/index.html' && !html.includes('pcxRenderGallery')) throw new Error('La tienda no incluye la galería por categoría.');
  if (file === 'public/index.html' && /prompt\(/.test(html)) throw new Error('La tienda no debe usar prompt().');
  if (file === 'public/crm-admin.html' && (!html.includes('loadAccessSlots') || !html.includes('createSlotAccessCode'))) throw new Error('El panel no incluye la administración de los tres códigos.');
  console.log(`${file}: ${scripts.length} scripts inline validados.`);
}
console.log('Validación estática PCX completada.');

const idx = readFileSync(join(root,"public/index.html"),"utf8"); const crm = readFileSync(join(root,"public/crm-admin.html"),"utf8");
for (const tk of ["pcxHeroSet","pcx-ui-v2"]) if (!idx.includes(tk)) throw new Error(`Tienda: falta ${tk}.`);
for (const tk of ["pcx-crm-v2","placeMedia","toggleCategory","removeCategory","confirmModal","mediaPicker"]) if (!crm.includes(tk)) throw new Error(`CRM: falta ${tk}.`);
console.log("Tokens v1.2 verificados.");
