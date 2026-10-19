#!/usr/bin/env bash
# Lanzador de Feedly Local WebGPU para Linux
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3040}"
URL="http://localhost:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: No se encontró Node.js. Instala Node.js v22.5 o superior desde https://nodejs.org/"
  exit 1
fi

if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ":${PORT} "; then
  echo "Feedly Local ya está en ejecución en ${URL}"
  command -v xdg-open >/dev/null 2>&1 && xdg-open "${URL}" >/dev/null 2>&1 &
  exit 0
fi

echo "Iniciando Feedly Local WebGPU en ${URL} ..."
if command -v xdg-open >/dev/null 2>&1; then
  (sleep 1.2 && xdg-open "${URL}" >/dev/null 2>&1) &
fi

node --no-warnings server.js
