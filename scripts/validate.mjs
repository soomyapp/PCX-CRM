import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const required = ['src/index.js','wrangler.jsonc','migrations/0001_schema.sql','public/index.html','public/crm-admin.html'];
for (const f of required) readFileSync(join(root,f));
execFileSync(process.execPath,['--check',join(root,'src/index.js')],{stdio:'inherit'});
const config = JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));
if (config.name !== 'pcx-crm-api' || !config.d1_databases?.some(x=>x.binding==='DB') || !config.r2_buckets?.some(x=>x.binding==='MEDIA')) throw new Error('wrangler.jsonc no contiene los bindings DB/MEDIA esperados.');
for (const file of ['public/index.html','public/crm-admin.html']) {
  const html=readFileSync(join(root,file),'utf8');
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m=>m[1]).filter(x=>x.trim());
  for (const [i,script] of scripts.entries()) {
    const tmp=join(tmpdir(),`pcx-${process.pid}-${i}.js`);
    try { writeFileSync(tmp,script); execFileSync(process.execPath,['--check',tmp],{stdio:'inherit'}); }
    finally { try { unlinkSync(tmp); } catch {} }
  }
  if (!html.includes('https://pcx-crm-api.lcreativo.workers.dev')) throw new Error(`${file} no apunta al Worker configurado.`);
  console.log(`${file}: ${scripts.length} scripts inline validados.`);
}
console.log('Validación estática PCX completada.');
