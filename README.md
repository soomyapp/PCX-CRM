# pcx-cloudflare — PCX CRM (repositorio oficial)

**Repositorio oficial: `soomyapp/PCX-CRM`. Carpeta de trabajo recomendada: `pcx-cloudflare`.**
Usa siempre `~/pcx-cloudflare` en Termux; conserva ese nombre de carpeta.

This repository contains the storefront, the standalone admin panel, and the Worker API source. It is configured for the existing Cloudflare resources:

- Worker: `pcx-crm-api` (`https://pcx-crm-api.lcreativo.workers.dev`)
- D1: `pcx-crm-db` (`53ffd641-c0f2-4ac7-a9ad-3de00dbe901a`)
- R2: `pcx-crm-media`
- Pages: `corporacionpcx` (`https://corporacionpcx.pages.dev`)

## Repository layout

- `public/index.html` — storefront and embedded CRM entry.
- `public/crm-admin.html` — standalone CRM admin.
- `src/index.js` — Cloudflare Worker API.
- `migrations/0001_schema.sql` — initial D1 schema.
- `migrations/0002_client_access_code_slots.sql` — three encrypted access-code slots.
- `wrangler.jsonc` — Worker, D1 and R2 bindings.
- `.github/workflows/deploy-cloudflare.yml` — deploy Worker and Pages after pushes to `main`.

## Despliegue automático universal

Incluye `pcx-deploy.sh`, compatible con Termux (Android), Linux y macOS:

```bash
# Validar, crear commit si hace falta y publicar en GitHub.
# El push dispara GitHub Actions para desplegar Worker + Pages.
bash ./pcx-deploy.sh github

# Alternativa: desplegar directamente desde el dispositivo con Wrangler.
bash ./pcx-deploy.sh local
```

El modo GitHub comprueba la rama `main`, bloquea el remoto antiguo `soomyapp/CMX-CMR`, valida el código y publica a `origin/main`. No inventa ni configura un remoto: `origin` debe apuntar a `https://github.com/soomyapp/PCX-CRM.git`.

**Carpeta canónica en Termux:** `~/pcx-cloudflare`. Extrae el ZIP dentro de esa carpeta y conserva `.git`.

## One-time GitHub setup

In the GitHub repository, open **Settings → Secrets and variables → Actions** and add this secret:

1. `CLOUDFLARE_API_TOKEN` — token with Workers Scripts: Edit, D1: Edit, R2 Storage: Edit, and Cloudflare Pages: Edit permissions for this account. The account ID is already configured in `wrangler.jsonc`.

Configura `CLOUDFLARE_API_TOKEN` una sola vez y conecta `origin` al repositorio oficial https://github.com/soomyapp/PCX-CRM.git, en la rama main. Ejecuta `bash ./pcx-deploy.sh github`. GitHub Actions then validates the Worker JavaScript, deploys `pcx-crm-api`, and deploys the `public/` directory to the existing Pages project `corporacionpcx`.

## First-time/manual deployment

Install Node.js 22 and run:

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply pcx-crm-db --remote
npx wrangler secret put DEVELOPER_KEY
npm run deploy
```

`DEVELOPER_KEY` must be set as a Cloudflare Worker secret. Do not put it in Git, HTML, `wrangler.jsonc`, or GitHub variables. When deploying over the existing Worker, an already configured Worker secret remains managed by Cloudflare; verify it in Worker Settings → Variables and Secrets.

The existing D1 database contains the current schema and catalog. Migrations are additive and preserve existing business rows. 0002_client_access_code_slots.sql adds the three encrypted access-code slots. Do not create a new database unless intentionally migrating data.

## Admin and client access codes

Open https://corporacionpcx.pages.dev/crm-admin.html. In Configuración → Tres códigos de acceso de clientes, the developer can manage exactly three fixed slots (Cliente 1, 2 and 3). Each active code is generated as eight numeric digits. Replacing a slot revokes its previous code; each slot can also be revoked independently.

The management API requires the Cloudflare Worker secret DEVELOPER_KEY in the X-Developer-Key header. The panel asks for this secret for each operation and does not save it in HTML or browser storage. D1 stores a SHA-256 hash for login validation and an AES-GCM encrypted copy for authorized recovery. The AES key is derived from DEVELOPER_KEY; do not rotate that secret unless you are prepared to replace all three codes, because old encrypted codes will no longer be recoverable. Keep the secret only in Cloudflare Worker Secrets.

Once all three new slots are active, the API deactivates legacy access-code rows that do not belong to a slot. New codes use the same login scope as the existing CRM: all three can enter the current administrative panel and have the same permissions. They are not separate restricted customer roles. Admin sessions expire after 12 hours.

## Verification

After deployment, check:

```bash
curl -i https://pcx-crm-api.lcreativo.workers.dev/api/health
curl -i https://pcx-crm-api.lcreativo.workers.dev/api/catalog
```

Expected: `/api/health` returns JSON with `ok: true`, database status, product count and R2 status; `/api/catalog` returns categories, products, banners and popups. Then test admin login, create/edit/deactivate a test product, upload a test image, submit a test lead, and create a test order before using the system operationally.

## Important deployment notes

- This is test-mode handoff. Do not treat test orders as real sales or connect payment capture without a separate payment-provider integration and explicit approval.
- The GitHub Actions workflow validates pull requests and, after a push to main, applies pending D1 migrations before deploying the Worker and Pages. It requires the CLOUDFLARE_API_TOKEN GitHub Actions secret above.
- The backend uses the existing D1/R2 resource identifiers and the frontend already points to the existing Worker URL.
- No credentials, developer secret, or initial access code are included in the repository.
