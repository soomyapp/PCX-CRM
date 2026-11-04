# Deployment acceptance checklist

- [ ] GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` configured.
- [ ] Workflow run completed successfully for Worker deployment.
- [ ] Workflow run completed successfully for Pages deployment.
- [ ] `/api/health` reports DB and R2 as `ok`.
- [ ] `/api/catalog` returns the expected 4 categories and 8 initial products.
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
