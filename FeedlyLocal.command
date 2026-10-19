#!/bin/zsh
# Lanzador rápido y gestor de autoinicio de Feedly Local (http://localhost:3040)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
PROJECT_DIR="/Volumes/MisAppsV/feedly_clon"
PLIST_NAME="com.jesusconde.feedlylocal.plist"
PLIST_SRC="$PROJECT_DIR/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"
APP_URL="http://localhost:3040"

cd "$PROJECT_DIR" || exit 1

# 1. Instalar y activar el servicio de autoinicio en macOS (LaunchAgent) si aún no está activo
if [ -f "$PLIST_SRC" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  if [ ! -f "$PLIST_DEST" ] || ! cmp -s "$PLIST_SRC" "$PLIST_DEST"; then
    cp "$PLIST_SRC" "$PLIST_DEST"
    launchctl unload "$PLIST_DEST" >/dev/null 2>&1
    launchctl load -w "$PLIST_DEST" >/dev/null 2>&1
  fi
fi

# 2. Comprobar si el servidor ya está respondiendo en el puerto 3040
if ! lsof -i :3040 -sTCP:LISTEN -t >/dev/null 2>&1; then
  # Intentar levantarlo mediante launchctl o directamente en segundo plano
  if [ -f "$PLIST_DEST" ]; then
    launchctl start com.jesusconde.feedlylocal >/dev/null 2>&1
  fi
  sleep 0.6
  if ! lsof -i :3040 -sTCP:LISTEN -t >/dev/null 2>&1; then
    nohup /opt/homebrew/bin/node --no-warnings "$PROJECT_DIR/server.js" >> "$PROJECT_DIR/data/server.log" 2>&1 &
  fi

  # Esperar hasta que el puerto 3040 esté listo (máx. 3 segundos)
  for i in {1..15}; do
    if lsof -i :3040 -sTCP:LISTEN -t >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

# 3. Abrir directamente Feedly Local en el navegador predeterminado
open "$APP_URL"
exit 0
