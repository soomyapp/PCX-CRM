# PCX · Actualización CRM ↔ Tienda (v1.1.0)

Todo lo que se hace en el CRM se guarda en D1/R2 y la tienda lo lee de `GET /api/catalog` (sin caché, resincroniza cada 60 s y al volver a la pestaña).

## Qué se refleja en la web
| Acción en el CRM | Resultado en la tienda |
|---|---|
| Subir foto/video a una **categoría** | Aparece al instante en la nueva sección **Galería** (pestañas por categoría + visor) |
| Ocultar / reordenar / eliminar archivo | Se oculta, cambia de orden o desaparece (también de R2) |
| Crear / renombrar / desactivar categoría | Filtro del catálogo, tarjetas de categoría y pestañas de la galería |
| Crear producto, cambiar precio, stock, categoría, fotos y video | Catálogo, ficha y carrito (precio y stock los valida el servidor) |
| Banners (hero / promoción / categoría) | Se muestran en su posición |
| Pop-ups | Se muestran con su retraso configurado |
| Cupones | Validados por el servidor al comprar |
| WhatsApp y redes (Configuración) | Botón de pedido y enlaces sociales (ya no se pregunta el número) |

## Despliegue (orden importa; el flujo de GitHub ya lo respeta)
1. Sube el proyecto a `main` (`bash ./pcx-deploy.sh github`) o usa `bash ./pcx-deploy.sh local`.
2. El flujo aplica **`0003_gallery_metrics.sql`** (aditiva: 3 columnas en `media_assets`, tabla `rate_limits`, índices; no borra datos), despliega el Worker y publica Pages.
3. Comprueba `https://pcx-crm-api.lcreativo.workers.dev/api/health`: debe mostrar `"gallery":"ok"`.
4. En el CRM → **Configuración**, escribe el WhatsApp comercial (formato `584244656724`) y guarda.
5. Los archivos que ya tenían categoría quedan publicados; los demás siguen solo en la biblioteca.

No cambian: nombres del Worker, D1, R2, Pages, secretos ni códigos de acceso.

## Correcciones importantes
- **El bloqueo de login (10 intentos/15 min) no funcionaba** por comparar fechas en formatos distintos; corregido.
- CORS no permitía `PUT`: guardar Configuración fallaba desde el navegador.
- Regex de acentos mal escapada en las posiciones de banner.
- `/media` sin caché ni Range (videos sin saltos) y sin validar la clave.
- Subidas: se valida el contenido real del archivo (no solo el tipo declarado).
- Slugs de producto únicos; cupones, banners, precios y estados validados; enlaces `javascript:` rechazados.
- Pedidos: se reutiliza el cliente por teléfono, no hay descuento silencioso con cupón inválido, cancelar un pedido devuelve stock y cupón.
- Límites de uso por IP (pedidos, solicitudes, cupones, clave de desarrollador) y limpieza de sesiones viejas.
- Tienda: sin `prompt()` para WhatsApp, salto de línea real en el mensaje, carrito vacío tras el pedido, productos agotados no se pueden añadir, enlace roto de imagen de respaldo.
- CRM: métricas reales (reemplazan datos ilustrativos), subir a una categoría ya no pisa su portada (botón «Usar de portada»), estados de pedido en español, clave de desarrollador en ventana propia.

## Métricas
«Ventas» = pedidos confirmados, en preparación, enviados o completados. Los **pendientes** se muestran aparte hasta que los marques como Confirmado en *Ventas y pedidos*. Días calculados en hora de Caracas.

## Pruebas
`npm test` (51 pruebas contra el Worker real con D1/R2 simulados) y `npm run check` (validación estática). Pruebas de interfaz con Chromium hechas en tienda y CRM, escritorio y móvil.

## Limpieza sugerida de datos actuales (no aplicada)
Categoría de prueba `cat-test-20261105` visible; «Plantas eléctricas» inactiva; `pcx-2` en «Iluminación LED»; todos los productos como destacados; pop-up «Black Friday» vacío e inactivo; cupón `PCX10` es de $5 fijos (mín. $50, 5 usos, hasta 2026-11-10).

---

# v1.2.0 — Hero, ficha de producto y CRM reestructurado

## Qué cambió
- **Hero**: los banners con ubicación «Carrusel principal (Hero)» (imagen o video) aparecen como carrusel con puntos, flechas y deslizamiento táctil. Si no hay banners, se mantienen los paneles por defecto.
- **Ficha de producto**: marco 1:1 con imagen contenida (sin recorte ni icono roto), deslizador de fotos/videos, pestañas «Fotos n/m» y «Vídeo», miniaturas, precio anterior con % de descuento, variantes reales y botón «Añadir al carrito».
- **CRM**: modales con cabecera fija, cuerpo con scroll y pie siempre visible; formularios por secciones; selector de biblioteca para banners/pop-ups.
- **Categorías**: Editar, Galería, Activar/Desactivar y Eliminar (permanente, con confirmación; los productos quedan «Sin categoría»).
- **Biblioteca → «Usar en la web…»**: galería de categoría, hero, banner promocional, banner de categoría, pop-up, portada de categoría o galería de producto. Cada archivo muestra dónde se usa.
- **Productos**: campos nuevos «Precio anterior / oferta» y «Variantes».

## Despliegue
1. Nueva migración **`0004_product_variants.sql`** (`ALTER TABLE products ADD COLUMN variants TEXT`). Tu workflow de GitHub Actions ya aplica las migraciones antes de desplegar el Worker.
2. Desplegar Worker y subir `public/` a Pages como siempre.
3. Comprobar `/api/health`: debe mostrar `gallery:"ok"` y `variants:"ok"`.

## Pruebas
`npm test` → 55 pruebas. Además se probó con navegador (Chromium) el CRM y la tienda en escritorio y móvil contra un Worker simulado. No se desplegó nada ni se tocó la base de datos de producción.
