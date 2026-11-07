-- 0003: galería publicable por categoría, orden de medios y límites de uso.
-- Aditiva: no borra ni modifica datos existentes. Los archivos que ya tienen
-- categoría quedan publicados (published=1) para que aparezcan en la web.
ALTER TABLE media_assets ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media_assets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_assets ADD COLUMN title TEXT;
CREATE INDEX IF NOT EXISTS idx_media_category ON media_assets(category_id, published, sort_order);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key_hash, window_start)
);
