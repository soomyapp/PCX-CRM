# PCX CRM — despliegue de producción

El despliegue oficial se ejecuta desde la rama `main` mediante GitHub Actions (`.github/workflows/deploy-cloudflare.yml`).

El flujo valida el proyecto, aplica migraciones pendientes de D1, publica el Worker `pcx-crm-api` y despliega la tienda y el panel CRM en Cloudflare Pages.

Requiere el secreto de repositorio `CLOUDFLARE_API_TOKEN` con permisos para Workers, D1 y Pages. No guardar tokens ni credenciales en este repositorio.
