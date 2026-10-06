#!/bin/sh
# Build guided-review's web UI. The server and the gr bridge need nothing but Node;
# npm is only used here, to build the UI into app/web/dist. Nothing is installed
# globally. Pass --rebuild to build even when a build already exists.
set -e
APP="$(cd "$(dirname "$0")/../app" && pwd)"
command -v node >/dev/null || { echo "node is required (>= 20)"; exit 1; }
command -v git >/dev/null || { echo "git is required"; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<20){console.error("Node "+process.version+" is too old: need >= 20");process.exit(1)}'
if [ -f "$APP/web/dist/index.html" ] && [ "$1" != "--rebuild" ]; then
  echo "web UI already built (pass --rebuild to rebuild)"
else
  cd "$APP"
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
  npm run build
fi
echo
"$(dirname "$0")/gr" doctor
