# API contract

Base URL: `https://pcx-crm-api.lcreativo.workers.dev`

## Public endpoints

- `GET /api/health` — Worker, D1 and R2 health summary.
- `GET /api/catalog` — active categories, products, banners and popups.
- `POST /api/coupons/validate` — `{ code, subtotal_cents }`.
- `POST /api/leads` — `{ name, phone, topic, message }`.
- `POST /api/orders` — `{ customer, items, coupon_code, shipping }`; validates stock, calculates totals and records the order.
- `GET /media/{object-key}` — retrieves an R2 object.

## Admin endpoints

All `/api/admin/*` endpoints except `/login` and `/access-codes/*` require `Authorization: Bearer <session-token>`. Sessions expire after 12 hours.

- `POST /api/admin/login` — `{ code }`.
- `POST /api/admin/logout`.
- `GET|POST /api/admin/products`; `PATCH|DELETE /api/admin/products/{id}`.
- `GET|POST /api/admin/categories`; `PATCH|DELETE /api/admin/categories/{id}`.
- `GET|POST /api/admin/coupons`; `PATCH|DELETE /api/admin/coupons/{id}`.
- `GET|POST /api/admin/banners`; `PATCH|DELETE /api/admin/banners/{id}`.
- `GET|POST /api/admin/popups`; `PATCH|DELETE /api/admin/popups/{id}`.
- `GET /api/admin/orders`; `PATCH /api/admin/orders/{id}`.
- `GET /api/admin/leads`; `PATCH /api/admin/leads/{id}`.
- `GET /api/admin/customers`.
- `GET|POST /api/admin/media`; `PATCH|DELETE /api/admin/media/{id}`.
- `GET|PUT /api/admin/settings`.
- `GET /api/admin/overview`.
- `POST /api/admin/access-codes` and `POST /api/admin/access-codes/{id}/revoke` require `X-Developer-Key` matching the Cloudflare secret `DEVELOPER_KEY`.

Media upload accepts JPEG, PNG, WebP, GIF, AVIF, MP4, WebM and PDF up to 20 MB. No payment gateway or payment capture is implemented; orders are test-mode records.
