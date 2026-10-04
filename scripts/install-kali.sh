#!/bin/bash
# ==============================================================================
# Interceptor Installer for Kali Linux & Debian-based Distributions
# ==============================================================================
# Supports:
#   - Kali Linux (x86_64, aarch64)
#   - Chromium, Google Chrome, and Brave Browser
#   - Full dynamic spidering and local network traffic capture
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================================"
echo "      Interceptor Installer for Kali Linux / Debian"
echo "============================================================"

# 1. System & User Detection
CURRENT_USER="${SUDO_USER:-$(id -un)}"
USER_HOME="${HOME}"
if [[ -n "${SUDO_USER:-}" && -d "/home/$SUDO_USER" ]]; then
  USER_HOME="/home/$SUDO_USER"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  BUN_ARCH="x64" ;;
  aarch64) BUN_ARCH="arm64" ;;
  *)
    echo "ERROR: Unsupported architecture '$ARCH'. Only x86_64 and aarch64 are supported." >&2
    exit 1
    ;;
esac

echo "[*] Detected Architecture: $ARCH ($BUN_ARCH)"
echo "[*] Target User:           $CURRENT_USER ($USER_HOME)"

# 2. Check Prerequisites on Kali Linux
echo "[*] Checking package dependencies..."
MISSING_PKGS=()
for cmd in curl jq unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    MISSING_PKGS+=("$cmd")
  fi
done

# Check browser
BROWSER_FOUND=0
for b in chromium chromium-browser google-chrome google-chrome-stable brave-browser brave; do
  if command -v "$b" >/dev/null 2>&1; then
    BROWSER_FOUND=1
    echo "[*] Found browser: $(command -v "$b")"
    break
  fi
done

if [[ "$BROWSER_FOUND" == "0" ]]; then
  echo "[!] No supported Chromium-based browser found on this system."
  if [[ "$(id -u)" == "0" ]]; then
    echo "[*] Installing Chromium via apt..."
    apt-get update -qq && apt-get install -y -qq chromium
  else
    echo "[!] Please install Chromium with: sudo apt-get update && sudo apt-get install -y chromium"
  fi
fi

if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  echo "[*] Installing missing utilities: ${MISSING_PKGS[*]}..."
  if [[ "$(id -u)" == "0" ]]; then
    apt-get update -qq && apt-get install -y -qq "${MISSING_PKGS[@]}"
  else
    echo "[!] Please install missing utilities: sudo apt-get install -y ${MISSING_PKGS[*]}"
  fi
fi

# 3. Check for Bun runtime or pre-compiled binaries
if ! command -v bun >/dev/null 2>&1; then
  echo "[*] Bun not found in PATH."
  if [[ -f "$USER_HOME/.bun/bin/bun" ]]; then
    export PATH="$USER_HOME/.bun/bin:$PATH"
    echo "[*] Found Bun in $USER_HOME/.bun/bin"
  else
    echo "[*] Installing Bun runtime for $CURRENT_USER..."
    if [[ "$(id -u)" == "0" && -n "${SUDO_USER:-}" ]]; then
      sudo -u "$CURRENT_USER" bash -c 'curl -fsSL https://bun.sh/install | bash'
      export PATH="$USER_HOME/.bun/bin:$PATH"
    else
      curl -fsSL https://bun.sh/install | bash
      export PATH="$HOME/.bun/bin:$PATH"
    fi
  fi
fi

# 4. Build or install binaries
echo "[*] Building Interceptor for Linux..."
cd "$ROOT"

if [[ -f "$ROOT/dist/linux/$BUN_ARCH/interceptor" && -f "$ROOT/dist/linux/$BUN_ARCH/daemon/interceptor-daemon" ]]; then
  echo "[*] Using existing Linux release binaries."
else
  if command -v bun >/dev/null 2>&1; then
    bun run build || bash scripts/build.sh --target=linux
  else
    echo "ERROR: Bun is required to build from source. Please ensure bun is in PATH." >&2
    exit 1
  fi
fi

# 5. System Installation Locations
INSTALL_BIN_DIR="/usr/local/bin"
INSTALL_LIB_DIR="/usr/local/lib/interceptor"
INSTALL_SHARE_DIR="/usr/local/share/interceptor"

echo "[*] Installing CLI and daemon to $INSTALL_BIN_DIR and $INSTALL_LIB_DIR..."
if [[ "$(id -u)" == "0" ]]; then
  mkdir -p "$INSTALL_BIN_DIR" "$INSTALL_LIB_DIR/daemon" "$INSTALL_SHARE_DIR"

  if [[ -f "$ROOT/dist/linux/$BUN_ARCH/interceptor" ]]; then
    cp "$ROOT/dist/linux/$BUN_ARCH/interceptor" "$INSTALL_BIN_DIR/interceptor"
    cp "$ROOT/dist/linux/$BUN_ARCH/daemon/interceptor-daemon" "$INSTALL_LIB_DIR/daemon/interceptor-daemon"
  elif [[ -f "$ROOT/dist/interceptor" ]]; then
    cp "$ROOT/dist/interceptor" "$INSTALL_BIN_DIR/interceptor"
    cp "$ROOT/daemon/interceptor-daemon" "$INSTALL_LIB_DIR/daemon/interceptor-daemon"
  fi

  ln -sf "$INSTALL_LIB_DIR/daemon/interceptor-daemon" "$INSTALL_BIN_DIR/interceptor-daemon" 2>/dev/null || true
  chmod 755 "$INSTALL_BIN_DIR/interceptor" "$INSTALL_LIB_DIR/daemon/interceptor-daemon"

  # Unpacked Extension staging
  if [[ -d "$ROOT/extension/dist" ]]; then
    cp -r "$ROOT/extension/dist" "$INSTALL_SHARE_DIR/extension"
    chmod -R u+rwX,go+rX "$INSTALL_SHARE_DIR/extension"
  fi
else
  # User-local install
  USER_BIN_DIR="$USER_HOME/.local/bin"
  USER_LIB_DIR="$USER_HOME/.local/share/interceptor"
  mkdir -p "$USER_BIN_DIR" "$USER_LIB_DIR/daemon"
  cp "$ROOT/dist/interceptor" "$USER_BIN_DIR/interceptor" 2>/dev/null || cp "$ROOT/dist/linux/$BUN_ARCH/interceptor" "$USER_BIN_DIR/interceptor"
  cp "$ROOT/daemon/interceptor-daemon" "$USER_LIB_DIR/daemon/interceptor-daemon" 2>/dev/null || cp "$ROOT/dist/linux/$BUN_ARCH/daemon/interceptor-daemon" "$USER_LIB_DIR/daemon/interceptor-daemon"
  chmod 755 "$USER_BIN_DIR/interceptor" "$USER_LIB_DIR/daemon/interceptor-daemon"
fi

# 6. Configure Native Messaging for Chromium, Chrome, and Brave
echo "[*] Setting up Native Messaging Hosts..."
DAEMON_PATH="$INSTALL_LIB_DIR/daemon/interceptor-daemon"
[[ ! -f "$DAEMON_PATH" ]] && DAEMON_PATH="$ROOT/daemon/interceptor-daemon"

NM_MANIFEST_CONTENT='{
  "name": "com.interceptor.host",
  "description": "Interceptor Native Messaging Host for AI Agent Browser Control",
  "path": "'"$DAEMON_PATH"'",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://gomcpnagjjlhehnkoobkjgnkbleiooed/",
    "chrome-extension://hkjbeknloepfcobpggllcghhpdbomjfl/"
  ]
}'

NM_TARGET_DIRS=(
  "$USER_HOME/.config/chromium/NativeMessagingHosts"
  "$USER_HOME/.config/google-chrome/NativeMessagingHosts"
  "$USER_HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
)

if [[ "$(id -u)" == "0" ]]; then
  NM_TARGET_DIRS+=(
    "/etc/chromium/native-messaging-hosts"
    "/etc/opt/chrome/native-messaging-hosts"
  )
fi

for nm_dir in "${NM_TARGET_DIRS[@]}"; do
  mkdir -p "$nm_dir"
  echo "$NM_MANIFEST_CONTENT" > "$nm_dir/com.interceptor.host.json"
  if [[ -n "${SUDO_USER:-}" ]]; then
    chown -R "$CURRENT_USER:$CURRENT_USER" "$nm_dir" 2>/dev/null || true
  fi
  echo "    Wrote: $nm_dir/com.interceptor.host.json"
done

# 7. Complete Installation
echo ""
echo "============================================================"
echo "  Interceptor successfully installed on Kali Linux!"
echo "============================================================"
echo "  CLI binary:      $(command -v interceptor || echo "$INSTALL_BIN_DIR/interceptor")"
echo "  Mode:            browser-only (Linux)"
echo "  Extension Dir:   $ROOT/extension/dist"
echo ""
echo "Next steps:"
echo "  1. Launch your browser (Chromium / Chrome / Brave)."
echo "  2. Go to chrome://extensions or brave://extensions."
echo "  3. Enable 'Developer Mode' toggle."
echo "  4. Click 'Load unpacked' and select:"
echo "     $ROOT/extension/dist"
echo ""
echo "Verify installation:"
echo "  interceptor status"
echo ""
echo "Run the dynamic spider feature (as shown in DEF CON 34 Bug Bounty Masterclass):"
echo "  interceptor spider https://target.com --scope domain --activate"
echo "============================================================"
