#!/usr/bin/env bash
# ============================================================
# dnstt Server Setup Script
# Sets up dnstt-server on a fresh Ubuntu/Debian VPS
# Usage: bash setup-server.sh
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
echo "   dnstt Server Setup Script"
echo "   DNS Tunnel Server + SSH"
echo "============================================"
echo ""

# ── Check root ──────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (or with sudo)"
    exit 1
fi

# ── Get configuration from user ─────────────────
read -rp "Enter your tunnel domain (e.g., t.example.com): " TUNNEL_DOMAIN
if [ -z "$TUNNEL_DOMAIN" ]; then
    error "Tunnel domain is required"
    exit 1
fi

read -rp "Enter network interface name [eth0]: " NET_IFACE
NET_IFACE=${NET_IFACE:-eth0}

read -rp "Enter dnstt listen port [5300]: " DNSTT_PORT
DNSTT_PORT=${DNSTT_PORT:-5300}

read -rp "Forward tunnel to which local port? [22 = SSH]: " FORWARD_PORT
FORWARD_PORT=${FORWARD_PORT:-22}

# ── Detect Go version ───────────────────────────
GO_VERSION="1.22.5"
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  GO_ARCH="amd64" ;;
    aarch64) GO_ARCH="arm64" ;;
    armv7l)  GO_ARCH="armv6l" ;;
    *)       error "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# ── Install dependencies ────────────────────────
log "Updating system packages..."
apt-get update -qq
apt-get install -y -qq git wget iptables iptables-persistent > /dev/null 2>&1

# ── Install Go ──────────────────────────────────
if command -v go &> /dev/null; then
    CURRENT_GO=$(go version | awk '{print $3}' | sed 's/go//')
    info "Go ${CURRENT_GO} is already installed"
else
    log "Installing Go ${GO_VERSION}..."
    wget -q "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" -O /tmp/go.tar.gz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz

    if ! grep -q '/usr/local/go/bin' /etc/profile; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile
    fi
    export PATH=$PATH:/usr/local/go/bin
    log "Go ${GO_VERSION} installed"
fi

# ── Create dnstt user ───────────────────────────
DNSTT_USER="dnstt"
if id "$DNSTT_USER" &>/dev/null; then
    info "User '${DNSTT_USER}' already exists"
else
    log "Creating user '${DNSTT_USER}'..."
    useradd -m -s /bin/bash "$DNSTT_USER"
fi

DNSTT_HOME="/home/${DNSTT_USER}"

# ── Build dnstt-server ──────────────────────────
log "Cloning and building dnstt..."
sudo -u "$DNSTT_USER" bash -c "
    export PATH=\$PATH:/usr/local/go/bin
    cd ${DNSTT_HOME}
    if [ ! -d dnstt ]; then
        git clone https://www.bamsoftware.com/git/dnstt.git
    fi
    cd dnstt/dnstt-server
    go build
"

# ── Generate keys ───────────────────────────────
KEY_DIR="${DNSTT_HOME}/dnstt/dnstt-server"
if [ ! -f "${KEY_DIR}/server.key" ]; then
    log "Generating server keypair..."
    sudo -u "$DNSTT_USER" bash -c "
        cd ${KEY_DIR}
        ./dnstt-server -gen-key -privkey-file server.key -pubkey-file server.pub
    "
    log "Keys generated"
else
    info "Server keys already exist"
fi

echo ""
echo "============================================"
info "Server Public Key (share with clients):"
echo -e "${CYAN}"
cat "${KEY_DIR}/server.pub"
echo -e "${NC}"
info "Server Private Key (for Cloudflare Worker):"
echo -e "${YELLOW}"
cat "${KEY_DIR}/server.key"
echo -e "${NC}"
echo "============================================"
echo ""

# ── Configure firewall ──────────────────────────
log "Configuring firewall (port 53 → ${DNSTT_PORT})..."

# IPv4
iptables -C INPUT -p udp --dport "$DNSTT_PORT" -j ACCEPT 2>/dev/null || \
    iptables -I INPUT -p udp --dport "$DNSTT_PORT" -j ACCEPT

iptables -t nat -C PREROUTING -i "$NET_IFACE" -p udp --dport 53 -j REDIRECT --to-ports "$DNSTT_PORT" 2>/dev/null || \
    iptables -t nat -I PREROUTING -i "$NET_IFACE" -p udp --dport 53 -j REDIRECT --to-ports "$DNSTT_PORT"

# IPv6
ip6tables -C INPUT -p udp --dport "$DNSTT_PORT" -j ACCEPT 2>/dev/null || \
    ip6tables -I INPUT -p udp --dport "$DNSTT_PORT" -j ACCEPT

ip6tables -t nat -C PREROUTING -i "$NET_IFACE" -p udp --dport 53 -j REDIRECT --to-ports "$DNSTT_PORT" 2>/dev/null || \
    ip6tables -t nat -I PREROUTING -i "$NET_IFACE" -p udp --dport 53 -j REDIRECT --to-ports "$DNSTT_PORT"

# Save rules
iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true

log "Firewall configured"

# ── Create systemd service ──────────────────────
log "Creating systemd service..."
cat > /etc/systemd/system/dnstt-server.service << EOF
[Unit]
Description=dnstt DNS Tunnel Server
After=network.target

[Service]
Type=simple
User=${DNSTT_USER}
WorkingDirectory=${KEY_DIR}
ExecStart=${KEY_DIR}/dnstt-server -udp :${DNSTT_PORT} -privkey-file ${KEY_DIR}/server.key ${TUNNEL_DOMAIN} 127.0.0.1:${FORWARD_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dnstt-server
systemctl start dnstt-server

log "dnstt-server service started"

# ── Verify ──────────────────────────────────────
sleep 2
if systemctl is-active --quiet dnstt-server; then
    log "dnstt-server is running!"
else
    error "dnstt-server failed to start. Check: journalctl -u dnstt-server"
fi

# ── Summary ─────────────────────────────────────
echo ""
echo "============================================"
echo -e "${GREEN}  Setup Complete!${NC}"
echo "============================================"
echo ""
info "Tunnel Domain:  ${TUNNEL_DOMAIN}"
info "Listen Port:    UDP ${DNSTT_PORT} (forwarded from 53)"
info "Forward To:     127.0.0.1:${FORWARD_PORT}"
info "Interface:      ${NET_IFACE}"
echo ""
info "Key Files:"
info "  Private: ${KEY_DIR}/server.key"
info "  Public:  ${KEY_DIR}/server.pub"
echo ""
info "Service Commands:"
info "  Status:  systemctl status dnstt-server"
info "  Logs:    journalctl -u dnstt-server -f"
info "  Restart: systemctl restart dnstt-server"
echo ""
warn "IMPORTANT: Add the private key to your Cloudflare Worker:"
warn "  wrangler secret put DNSTT_PRIVKEY"
warn "  (paste the content of server.key)"
echo ""
warn "IMPORTANT: Configure DNS records:"
warn "  A     tns.${TUNNEL_DOMAIN#*.}  →  $(curl -s ifconfig.me 2>/dev/null || echo '<YOUR-SERVER-IP>')"
warn "  NS    ${TUNNEL_DOMAIN}     →  tns.${TUNNEL_DOMAIN#*.}"
echo ""
