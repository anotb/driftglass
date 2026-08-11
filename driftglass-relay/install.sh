#!/bin/sh
set -eu

base="${1:-}"
if [ -z "$base" ]; then
  echo "Usage: curl -fsSL https://YOUR-DRIFTGLASS/relay/install.sh | sh -s -- https://YOUR-DRIFTGLASS" >&2
  exit 2
fi
base="${base%/}"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    echo "This installer supports macOS and Linux. On Windows use: irm $base/relay/install.ps1 | iex" >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install it, then run this command again." >&2
  exit 1
fi
major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$major" -lt 20 ]; then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM
curl -fsSL "$base/relay/manifest.json" -o "$work/manifest.json"
curl -fsSL "$base/relay/driftglass-relay.mjs" -o "$work/driftglass-relay.mjs"
expected="$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.files["driftglass-relay.mjs"].sha256)' "$work/manifest.json")"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$work/driftglass-relay.mjs" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/driftglass-relay.mjs" | awk '{print $1}')"
else
  actual="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$work/driftglass-relay.mjs")"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Relay checksum verification failed." >&2
  exit 1
fi

dest_dir="$HOME/.local/bin"
dest="$dest_dir/driftglass-relay"
companion="$dest_dir/driftglass-companion"
mkdir -p "$dest_dir"
cp "$work/driftglass-relay.mjs" "$dest"
chmod 755 "$dest"
cp "$dest" "$companion"
chmod 755 "$companion"

echo "Installed $dest and $companion"
if ! command -v opencli >/dev/null 2>&1; then
  echo "For logged-in sources, install OpenCLIApp or @jackwener/opencli and its Browser Bridge."
fi
case ":$PATH:" in
  *":$dest_dir:"*) ;;
  *) echo "Add this to your shell profile: export PATH=\"$dest_dir:\$PATH\"" ;;
esac
