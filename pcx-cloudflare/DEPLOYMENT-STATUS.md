# Estado del despliegue PCX

El despliegue de producción se ejecuta desde GitHub Actions al recibir cambios en `main`.

El flujo valida el proyecto, aplica las migraciones pendientes de D1, publica `pcx-crm-api` en Cloudflare Workers y despliega la tienda y el CRM en Cloudflare Pages.

Se requiere el secreto de repositorio `CLOUDFLARE_API_TOKEN` con permisos para Workers, D1, R2 y Pages. El valor del secreto nunca debe almacenarse en el repositorio ni compartirse en conversaciones.

URLs de producción:
- Tienda: https://corporacionpcx.pages.dev/
- CRM: https://corporacionpcx.pages.dev/crm-admin.html
