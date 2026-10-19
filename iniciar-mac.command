#!/bin/bash
# Lanzador de Feedly Local WebGPU para macOS
cd "$(dirname "$0")" || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-3040}"
URL="http://localhost:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: No se encontró Node.js. Instala Node.js v22.5 o superior desde https://nodejs.org/"
  read -r -p "Pulsa Intro para salir..."
  exit 1
fi

if lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Feedly Local ya está en ejecución en ${URL}"
  open "${URL}"
  exit 0
fi

echo "Iniciando Feedly Local WebGPU en ${URL} ..."
(sleep 1.2 && open "${URL}") &
node --no-warnings server.js
