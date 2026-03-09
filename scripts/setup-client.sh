#!/usr/bin/env bash
# ============================================================
# dnstt Client Setup Script (Linux/macOS)
# Sets up dnstt-client and SSH SOCKS proxy
# Usage: bash setup-client.sh
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; }
info()  { echo -e "${CYAN}[i]${NC} $1"; }

echo ""
echo "============================================"
echo "   dnstt Client Setup Script"
echo "   DNS Tunnel Client + SSH SOCKS Proxy"
echo "============================================"
echo ""

# ── Get configuration ───────────────────────────
read -rp "Enter your Cloudflare Worker URL (e.g., https://dnstt-worker.you.workers.dev): " WORKER_URL
if [ -z "$WORKER_URL" ]; then
    error "Worker URL is required"
    exit 1
fi

read -rp "Enter your tunnel domain (e.g., t.example.com): " TUNNEL_DOMAIN
if [ -z "$TUNNEL_DOMAIN" ]; then
    error "Tunnel domain is required"
    exit 1
fi

read -rp "Enter path to server.pub file [./server.pub]: " PUBKEY_FILE
PUBKEY_FILE=${PUBKEY_FILE:-./server.pub}

if [ ! -f "$PUBKEY_FILE" ]; then
    warn "server.pub not found at ${PUBKEY_FILE}"
    read -rp "Enter the public key as hex string: " PUBKEY_HEX
    if [ -z "$PUBKEY_HEX" ]; then
        error "Public key is required"
        exit 1
    fi
    USE_PUBKEY_HEX=true
else
    USE_PUBKEY_HEX=false
fi

read -rp "SSH username on the server: " SSH_USER
if [ -z "$SSH_USER" ]; then
    error "SSH username is required"
    exit 1
fi

read -rp "SSH server hostname (for HostKeyAlias) [your-server]: " SSH_HOST
SSH_HOST=${SSH_HOST:-your-server}

read -rp "Local tunnel port [8000]: " TUNNEL_PORT
TUNNEL_PORT=${TUNNEL_PORT:-8000}

read -rp "Local SOCKS proxy port [1080]: " SOCKS_PORT
SOCKS_PORT=${SOCKS_PORT:-1080}

# ── Detect OS and architecture ──────────────────
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
    x86_64)  GO_ARCH="amd64" ;;
    aarch64) GO_ARCH="arm64" ;;
    arm64)   GO_ARCH="arm64" ;;
    armv7l)  GO_ARCH="armv6l" ;;
    *)       error "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# ── Install Go if needed ────────────────────────
GO_VERSION="1.22.5"
if ! command -v go &> /dev/null; then
    log "Installing Go ${GO_VERSION}..."
    wget -q "https://go.dev/dl/go${GO_VERSION}.${OS}-${GO_ARCH}.tar.gz" -O /tmp/go.tar.gz
    sudo tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz
    export PATH=$PATH:/usr/local/go/bin
    log "Go installed"
else
    info "Go is already installed"
fi

# ── Build dnstt-client ──────────────────────────
INSTALL_DIR="$HOME/dnstt"
log "Building dnstt-client..."

if [ ! -d "$INSTALL_DIR" ]; then
    git clone https://www.bamsoftware.com/git/dnstt.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/dnstt-client"
go build
log "dnstt-client built successfully"

# ── Copy public key ─────────────────────────────
if [ "$USE_PUBKEY_HEX" = false ]; then
    cp "$PUBKEY_FILE" "$INSTALL_DIR/dnstt-client/server.pub"
    PUBKEY_OPT="-pubkey-file server.pub"
else
    PUBKEY_OPT="-pubkey ${PUBKEY_HEX}"
fi

# ── Create convenience scripts ──────────────────
CLIENT_DIR="$INSTALL_DIR/dnstt-client"

cat > "${CLIENT_DIR}/start-tunnel.sh" << SCRIPT
#!/usr/bin/env bash
# Start the dnstt tunnel
echo "Starting dnstt tunnel..."
echo "  Worker:  ${WORKER_URL}"
echo "  Domain:  ${TUNNEL_DOMAIN}"
echo "  Listen:  127.0.0.1:${TUNNEL_PORT}"
echo ""
echo "Press Ctrl+C to stop"
echo ""
cd "${CLIENT_DIR}"
./dnstt-client -doh "${WORKER_URL}/dns-query" \\
  ${PUBKEY_OPT} \\
  ${TUNNEL_DOMAIN} \\
  127.0.0.1:${TUNNEL_PORT}
SCRIPT
chmod +x "${CLIENT_DIR}/start-tunnel.sh"

cat > "${CLIENT_DIR}/start-ssh-proxy.sh" << SCRIPT
#!/usr/bin/env bash
# Start SSH SOCKS proxy through the dnstt tunnel
echo "Connecting SSH through dnstt tunnel..."
echo "  SOCKS proxy will be at: 127.0.0.1:${SOCKS_PORT}"
echo ""
ssh -N -D 127.0.0.1:${SOCKS_PORT} \\
  -o HostKeyAlias=${SSH_HOST} \\
  -o StrictHostKeyChecking=accept-new \\
  -p ${TUNNEL_PORT} \\
  ${SSH_USER}@127.0.0.1
SCRIPT
chmod +x "${CLIENT_DIR}/start-ssh-proxy.sh"

cat > "${CLIENT_DIR}/start-all.sh" << SCRIPT
#!/usr/bin/env bash
# Start tunnel + SSH proxy together
echo "============================================"
echo "  dnstt Tunnel + SSH SOCKS Proxy"
echo "============================================"
echo ""
echo "Step 1: Starting dnstt tunnel in background..."
cd "${CLIENT_DIR}"
./dnstt-client -doh "${WORKER_URL}/dns-query" \\
  ${PUBKEY_OPT} \\
  ${TUNNEL_DOMAIN} \\
  127.0.0.1:${TUNNEL_PORT} &
TUNNEL_PID=\$!
echo "  Tunnel PID: \$TUNNEL_PID"

sleep 3

echo ""
echo "Step 2: Starting SSH SOCKS proxy..."
echo "  SOCKS5 proxy: 127.0.0.1:${SOCKS_PORT}"
echo ""
echo "Configure your browser/apps to use:"
echo "  SOCKS5 proxy: 127.0.0.1:${SOCKS_PORT}"
echo "  Enable 'Proxy DNS when using SOCKS v5'"
echo ""
echo "Press Ctrl+C to stop everything"
echo ""

trap "kill \$TUNNEL_PID 2>/dev/null; exit" INT TERM

ssh -N -D 127.0.0.1:${SOCKS_PORT} \\
  -o HostKeyAlias=${SSH_HOST} \\
  -o StrictHostKeyChecking=accept-new \\
  -p ${TUNNEL_PORT} \\
  ${SSH_USER}@127.0.0.1

kill \$TUNNEL_PID 2>/dev/null
SCRIPT
chmod +x "${CLIENT_DIR}/start-all.sh"

# ── Summary ─────────────────────────────────────
echo ""
echo "============================================"
echo -e "${GREEN}  Client Setup Complete!${NC}"
echo "============================================"
echo ""
info "Files installed to: ${CLIENT_DIR}"
echo ""
info "Quick Start:"
echo ""
echo "  1. Start the tunnel:"
echo -e "     ${CYAN}${CLIENT_DIR}/start-tunnel.sh${NC}"
echo ""
echo "  2. In another terminal, start SSH proxy:"
echo -e "     ${CYAN}${CLIENT_DIR}/start-ssh-proxy.sh${NC}"
echo ""
echo "  Or start both at once:"
echo -e "     ${CYAN}${CLIENT_DIR}/start-all.sh${NC}"
echo ""
info "Browser Configuration:"
echo "  Set SOCKS5 proxy to: 127.0.0.1:${SOCKS_PORT}"
echo "  Enable: 'Proxy DNS when using SOCKS v5'"
echo ""
info "Test with:"
echo "  curl --proxy socks5h://127.0.0.1:${SOCKS_PORT}/ https://ifconfig.me"
echo ""
