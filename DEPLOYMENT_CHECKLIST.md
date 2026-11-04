# Deployment acceptance checklist

- [ ] GitHub Actions secret `CLOUDFLARE_API_TOKEN` configured with Workers, D1 and Pages edit permissions.
- [ ] Workflow run completed successfully for Worker deployment.
- [ ] Workflow run completed successfully for Pages deployment.
- [ ] `/api/health` reports DB and R2 as `ok`.
- [ ] `/api/catalog` returns the expected 4 categories and 8 initial products.
- [ ] D1 migration `0002_client_access_code_slots.sql` applied successfully.
- [ ] Exactly three client slots can be generated, recovered, replaced and revoked.
- [ ] All three login codes are eight numeric digits and legacy codes are inactive after all slots are provisioned.
- [ ] Admin access code login succeeds.
- [ ] Test product create/edit/deactivate succeeds.
- [ ] Test media upload and retrieval from R2 succeeds.
- [ ] Test coupon validation succeeds.
- [ ] Test lead creation and status update succeeds.
- [ ] Test order creation, stock decrement, and order status update succeed.
- [ ] Verify no real payment is being captured.


## Nombre y publicación permanentes
- Repositorio/carpeta oficial: `pcx-cloudflare` (no renombrar).
- En Termux: `~/pcx-cloudflare`.
- Publicar y disparar despliegue automático: `bash ./pcx-deploy.sh github`.
- Despliegue directo desde el dispositivo: `bash ./pcx-deploy.sh local`.
- GitHub Actions requiere el secreto `CLOUDFLARE_API_TOKEN`.
