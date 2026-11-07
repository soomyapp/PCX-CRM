# API contract

Base URL: `https://pcx-crm-api.lcreativo.workers.dev`

## Public endpoints

- `GET /api/health` — Worker, D1 and R2 health summary.
- `GET /api/catalog` — active categories (each with its published `gallery`), flat `gallery`, products (price, stock, media), banners, popups and public `settings` (WhatsApp, store name, social links). Sent with `Cache-Control: no-cache`.
- `POST /api/coupons/validate` — `{ code, subtotal_cents }`.
- `POST /api/leads` — `{ name, phone, topic, message }`.
- `POST /api/orders` — `{ customer, items, coupon_code, shipping }`; validates stock, calculates totals and records the order.
- `GET|HEAD /media/{object-key}` — retrieves an R2 object (Range supported, immutable cache). Keys are validated.

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
- `GET|POST /api/admin/media` (headers `X-File-Name`, `X-Category-ID`, `X-Published`; magic-byte validated); `PATCH|DELETE /api/admin/media/{id}` (PATCH: `category_id`, `published`, `title`, `alt_text`, `sort_order`); `POST /api/admin/media/reorder` `{ ids: [...] }`.
- `GET|PUT /api/admin/settings`.
- `GET /api/admin/overview`.
- `GET /api/admin/metrics?days=7..365` — sales (confirmed/processing/shipped/completed), previous-period comparison, daily series (America/Caracas), top products, by category, by status, low stock.
- `GET /api/admin/access-codes` returns the three fixed slots and decrypts active codes for authorized recovery; requires `X-Developer-Key`.
- `POST /api/admin/access-codes` with `{ slot: 1|2|3 }` generates an eight-digit numeric code and replaces the active code in that slot; requires `X-Developer-Key`.
- `POST /api/admin/access-codes/slot/{slot}/revoke` revokes the active code in slot 1, 2 or 3; requires `X-Developer-Key`.
- Legacy revoke endpoints remain available for compatibility. The developer key is the Cloudflare Worker secret `DEVELOPER_KEY`.
- Login validation stores SHA-256 hashes; recoverable copies are encrypted with AES-GCM using a key derived from `DEVELOPER_KEY`. Do not rotate that secret without replacing all three codes.

Media upload accepts JPEG, PNG, WebP, GIF, AVIF, MP4, WebM and PDF up to 20 MB. No payment gateway or payment capture is implemented; orders are test-mode records.

Rate limits: orders 20/10 min, leads 10/10 min, coupon validation 60/10 min per IP; developer-key routes 30/15 min; login 10 failed attempts/15 min.
Order status changes: `cancelled` returns stock and coupon use; reactivating re-deducts stock (409 if insufficient).

## v1.2
- `products.variants`: lista de textos (máx. 8). En POST/PATCH admin se acepta lista o texto separado por comas/saltos de línea.
- Banners/pop-ups con `media_id` de un video devuelven `video_url` e `image_url: null`.
- `DELETE /api/admin/categories/:id?permanent=1`: borra la categoría; productos y archivos quedan sin categoría. Sin `permanent`, solo desactiva.
- Pedidos: cada línea puede incluir `variant`.
