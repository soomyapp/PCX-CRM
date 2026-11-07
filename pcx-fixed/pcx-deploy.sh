#!/usr/bin/env bash
# PCX Cloudflare — universal deploy helper (Termux, Linux, macOS)
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"
say() { printf '\n[PCX] %s\n' "$*"; }
die() { printf '\n[PCX ERROR] %s\n' "$*" >&2; exit 1; }
MODE="${1:-github}"
case "$MODE" in github|--github) MODE="github";; local|--local) MODE="local";; *) die "Uso: bash pcx-deploy.sh [github|local]";; esac
command -v node >/dev/null 2>&1 || die "Falta Node.js. En Termux: pkg install nodejs-lts git -y"
command -v npm >/dev/null 2>&1 || die "npm no está disponible."
command -v git >/dev/null 2>&1 || die "Falta Git. En Termux: pkg install git -y"
[[ -f package.json && -f wrangler.jsonc && -f src/index.js ]] || die "No parece la raíz del proyecto pcx-cloudflare. Extrae el ZIP dentro de ~/pcx-cloudflare."
say "Proyecto oficial: soomyapp/PCX-CRM | $ROOT"
say "Validando código..."
npm install
npm run check
node --check src/index.js
if [[ "$MODE" == github ]]; then
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Esta carpeta no es un repositorio Git. Clona pcx-cloudflare primero."
  BRANCH="$(git branch --show-current)"
  [[ "$BRANCH" == main ]] || die "La rama actual es '$BRANCH'. Cambia a main antes de publicar."
  REMOTE="$(git remote get-url origin 2>/dev/null || true)"
  [[ -n "$REMOTE" ]] || die "No existe origin. Configura origin a https://github.com/soomyapp/PCX-CRM.git."
  if printf '%s' "$REMOTE" | grep -qiE 'soomyapp/CMX-CMR'; then die "Remoto antiguo bloqueado: soomyapp/CMX-CMR."; fi
  printf '%s' "$REMOTE" | grep -qiE 'soomyapp/PCX-CRM(\.git)?$' || die "El remoto origin no es el repositorio oficial soomyapp/PCX-CRM."
  say "Preparando cambios para GitHub..."
  git add -A
  if ! git diff --cached --quiet; then
    git -c user.name="PCX Deploy" -c user.email="pcx-deploy@users.noreply.github.com" commit -m "Deploy PCX CRM"
  else say "No hay cambios nuevos para confirmar."; fi
  say "Publicando en GitHub..."
  git push -u origin main
  say "Código enviado al repositorio oficial soomyapp/PCX-CRM. GitHub Actions desplegará Worker y Pages automáticamente."
  say "Configura una sola vez CLOUDFLARE_API_TOKEN en GitHub > Settings > Secrets and variables > Actions."
  exit 0
fi
say "Comprobando sesión Cloudflare..."
if ! npx wrangler whoami >/dev/null 2>&1; then npx wrangler login; fi
say "Aplicando migraciones D1 (no elimina filas existentes)..."
npx wrangler d1 migrations apply pcx-crm-db --remote
say "Desplegando Worker..."
npx wrangler deploy
say "Desplegando Pages..."
npx wrangler pages deploy public --project-name=corporacionpcx
say "Comprobando API..."
curl --fail --silent --show-error https://pcx-crm-api.lcreativo.workers.dev/api/health
printf '\n'
say "Despliegue local completado."
