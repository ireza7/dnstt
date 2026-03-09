#!/usr/bin/env bash
#
# server-setup.sh - dnstt + SSH Server Auto-Setup Script
#
# This script automates the full setup of a dnstt DNS tunnel server
# with SSH SOCKS proxy on a Linux VPS.
#
# Usage:
#   chmod +x server-setup.sh
#   sudo ./server-setup.sh
#
# Requirements:
#   - A Linux VPS (Ubuntu/Debian/CentOS/Fedora)
#   - Root access
#   - A domain name with DNS properly configured
#
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Functions ---
print_header() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   dnstt + SSH Server Setup Script            ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
}

print_step() {
    echo -e "\n${BLUE}[*]${NC} $1"
}

print_ok() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_err() {
    echo -e "${RED}[✗]${NC} $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_err "This script must be run as root (use sudo)"
        exit 1
    fi
}

detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
    else
        print_err "Cannot detect OS"
        exit 1
    fi
}

detect_arch() {
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  GOARCH="amd64" ;;
        aarch64) GOARCH="arm64" ;;
        armv7l)  GOARCH="arm" ;;
        *)
            print_err "Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac
    print_ok "Architecture detected: $ARCH ($GOARCH)"
}

detect_interface() {
    # Try to auto-detect the main network interface
    IFACE=$(ip route show default | awk '/default/ {print $5}' | head -1)
    if [ -z "$IFACE" ]; then
        IFACE="eth0"
    fi
    print_ok "Network interface: $IFACE"
}

install_dependencies() {
    print_step "Installing dependencies..."
    case "$OS" in
        ubuntu|debian)
            apt-get update -qq
            apt-get install -y -qq wget tar iptables openssh-server > /dev/null 2>&1
            ;;
        centos|rhel|fedora|rocky|alma)
            yum install -y -q wget tar iptables openssh-server > /dev/null 2>&1
            ;;
        *)
            print_warn "Unknown OS '$OS'. Attempting with apt..."
            apt-get update -qq && apt-get install -y -qq wget tar iptables openssh-server > /dev/null 2>&1
            ;;
    esac
    print_ok "Dependencies installed"
}

get_server_ip() {
    SERVER_IP=$(curl -s4 ifconfig.me || curl -s4 icanhazip.com || echo "UNKNOWN")
    if [ "$SERVER_IP" = "UNKNOWN" ]; then
        print_warn "Could not detect server IP automatically"
        read -rp "Enter your server's public IP address: " SERVER_IP
    fi
    print_ok "Server IP: $SERVER_IP"
}

prompt_config() {
    echo ""
    echo -e "${YELLOW}═══ Configuration ═══${NC}"
    echo ""

    read -rp "Enter your tunnel domain (e.g., t.example.com): " TUNNEL_DOMAIN
    if [ -z "$TUNNEL_DOMAIN" ]; then
        print_err "Domain cannot be empty"
        exit 1
    fi

    read -rp "Enter dnstt listen port [5300]: " DNSTT_PORT
    DNSTT_PORT=${DNSTT_PORT:-5300}

    read -rp "Enter SSH forward port [22]: " SSH_PORT
    SSH_PORT=${SSH_PORT:-22}

    echo ""
    echo -e "${CYAN}Configuration Summary:${NC}"
    echo "  Tunnel domain:  $TUNNEL_DOMAIN"
    echo "  dnstt port:     $DNSTT_PORT"
    echo "  SSH port:       $SSH_PORT"
    echo "  Server IP:      $SERVER_IP"
    echo ""
    read -rp "Continue? (y/n): " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
}

download_or_build() {
    print_step "Setting up dnstt binaries..."

    INSTALL_DIR="/opt/dnstt"
    mkdir -p "$INSTALL_DIR"

    # Check if GitHub release binaries are available (from user's fork)
    REPO_URL="${DNSTT_REPO_URL:-https://github.com/ireza7/dnstt}"
    RELEASE_URL="${REPO_URL}/releases/latest/download/dnstt-linux-${GOARCH}.tar.gz"

    print_step "Trying to download pre-built binary from: $RELEASE_URL"
    if wget -q -O /tmp/dnstt.tar.gz "$RELEASE_URL" 2>/dev/null; then
        tar xzf /tmp/dnstt.tar.gz -C "$INSTALL_DIR" --strip-components=1
        rm -f /tmp/dnstt.tar.gz
        print_ok "Downloaded pre-built binaries"
    else
        print_warn "Pre-built binary not found. Building from source..."
        build_from_source
    fi

    # Rename binaries to standard names
    if [ -f "$INSTALL_DIR/dnstt-server-linux-${GOARCH}" ]; then
        mv "$INSTALL_DIR/dnstt-server-linux-${GOARCH}" "$INSTALL_DIR/dnstt-server"
    fi
    if [ -f "$INSTALL_DIR/dnstt-client-linux-${GOARCH}" ]; then
        mv "$INSTALL_DIR/dnstt-client-linux-${GOARCH}" "$INSTALL_DIR/dnstt-client"
    fi

    chmod +x "$INSTALL_DIR/dnstt-server" "$INSTALL_DIR/dnstt-client" 2>/dev/null || true
    print_ok "dnstt binaries ready at $INSTALL_DIR"
}

build_from_source() {
    print_step "Installing Go..."

    GO_VERSION="1.21.13"
    case "$GOARCH" in
        amd64) GO_ARCHIVE="go${GO_VERSION}.linux-amd64.tar.gz" ;;
        arm64) GO_ARCHIVE="go${GO_VERSION}.linux-arm64.tar.gz" ;;
        arm)   GO_ARCHIVE="go${GO_VERSION}.linux-armv6l.tar.gz" ;;
    esac

    wget -q "https://go.dev/dl/${GO_ARCHIVE}" -O /tmp/go.tar.gz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz
    export PATH=$PATH:/usr/local/go/bin

    print_step "Cloning and building dnstt..."
    REPO="${DNSTT_REPO_URL:-https://github.com/ireza7/dnstt}"
    TMPDIR=$(mktemp -d)
    git clone --depth 1 "$REPO" "$TMPDIR/dnstt"

    cd "$TMPDIR/dnstt/dnstt-server"
    CGO_ENABLED=0 go build -ldflags="-s -w" -o "$INSTALL_DIR/dnstt-server"

    cd "$TMPDIR/dnstt/dnstt-client"
    CGO_ENABLED=0 go build -ldflags="-s -w" -o "$INSTALL_DIR/dnstt-client"

    rm -rf "$TMPDIR"
    print_ok "Built from source successfully"
}

generate_keys() {
    print_step "Generating encryption keys..."
    cd "$INSTALL_DIR"

    if [ ! -f server.key ] || [ ! -f server.pub ]; then
        ./dnstt-server -gen-key -privkey-file server.key -pubkey-file server.pub
        chmod 600 server.key
        chmod 644 server.pub
        print_ok "Keys generated"
    else
        print_warn "Keys already exist, skipping generation"
    fi

    PUBKEY=$(cat server.pub)
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  PUBLIC KEY (copy this to clients):                             ║${NC}"
    echo -e "${GREEN}║  $PUBKEY  ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

setup_iptables() {
    print_step "Setting up iptables port forwarding (53 → $DNSTT_PORT)..."

    # IPv4
    iptables -I INPUT -p udp --dport "$DNSTT_PORT" -j ACCEPT 2>/dev/null || true
    iptables -t nat -I PREROUTING -i "$IFACE" -p udp --dport 53 -j REDIRECT --to-ports "$DNSTT_PORT" 2>/dev/null || true

    # IPv6
    ip6tables -I INPUT -p udp --dport "$DNSTT_PORT" -j ACCEPT 2>/dev/null || true
    ip6tables -t nat -I PREROUTING -i "$IFACE" -p udp --dport 53 -j REDIRECT --to-ports "$DNSTT_PORT" 2>/dev/null || true

    # Save rules
    if command -v iptables-save &> /dev/null; then
        iptables-save > /etc/iptables.rules 2>/dev/null || true
    fi

    print_ok "iptables rules configured"
}

create_systemd_service() {
    print_step "Creating systemd service..."

    cat > /etc/systemd/system/dnstt-server.service << EOF
[Unit]
Description=dnstt DNS Tunnel Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=nobody
Group=nogroup
ExecStart=$INSTALL_DIR/dnstt-server -udp :$DNSTT_PORT -privkey-file $INSTALL_DIR/server.key $TUNNEL_DOMAIN 127.0.0.1:$SSH_PORT
Restart=always
RestartSec=5
LimitNOFILE=65535

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=$INSTALL_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable dnstt-server
    systemctl start dnstt-server

    sleep 2
    if systemctl is-active --quiet dnstt-server; then
        print_ok "dnstt-server service is running"
    else
        print_err "dnstt-server failed to start. Check: journalctl -u dnstt-server"
    fi
}

save_client_info() {
    print_step "Saving client connection info..."

    CLIENT_INFO="$INSTALL_DIR/client-info.txt"
    PUBKEY=$(cat "$INSTALL_DIR/server.pub")

    cat > "$CLIENT_INFO" << EOF
═══════════════════════════════════════════════════════
  dnstt Client Connection Information
═══════════════════════════════════════════════════════

Server IP:      $SERVER_IP
Tunnel Domain:  $TUNNEL_DOMAIN
Public Key:     $PUBKEY

─── DoH Mode (Recommended) ────────────────────────────

  ./dnstt-client -doh https://cloudflare-dns.com/dns-query \\
    -pubkey-file server.pub \\
    $TUNNEL_DOMAIN 127.0.0.1:2222

─── DoT Mode ──────────────────────────────────────────

  ./dnstt-client -dot 1.1.1.1:853 \\
    -pubkey-file server.pub \\
    $TUNNEL_DOMAIN 127.0.0.1:2222

─── SSH through tunnel ────────────────────────────────

  ssh -o HostKeyAlias=$SERVER_IP -p 2222 YOUR_USER@127.0.0.1

─── SSH SOCKS Proxy ───────────────────────────────────

  ssh -N -D 127.0.0.1:1080 \\
    -o HostKeyAlias=$SERVER_IP \\
    -p 2222 YOUR_USER@127.0.0.1

  Then set SOCKS5 proxy to: 127.0.0.1:1080

═══════════════════════════════════════════════════════
EOF

    print_ok "Client info saved to: $CLIENT_INFO"
}

print_summary() {
    PUBKEY=$(cat "$INSTALL_DIR/server.pub")

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    Setup Complete!                               ║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║                                                                  ║${NC}"
    echo -e "${GREEN}║  Service Status:  systemctl status dnstt-server                  ║${NC}"
    echo -e "${GREEN}║  View Logs:       journalctl -u dnstt-server -f                  ║${NC}"
    echo -e "${GREEN}║  Client Info:     cat $INSTALL_DIR/client-info.txt     ║${NC}"
    echo -e "${GREEN}║                                                                  ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}PUBLIC KEY:${NC} $PUBKEY"
    echo ""
    echo -e "${YELLOW}DNS Records Needed:${NC}"
    echo "  A     tns.${TUNNEL_DOMAIN#*.}  →  $SERVER_IP"
    echo "  NS    $TUNNEL_DOMAIN           →  tns.${TUNNEL_DOMAIN#*.}"
    echo ""
    echo -e "${CYAN}Test with:${NC}"
    echo "  dig +short $TUNNEL_DOMAIN @$SERVER_IP"
    echo ""
}

# --- Main ---
main() {
    print_header
    check_root
    detect_os
    detect_arch
    detect_interface
    install_dependencies
    get_server_ip
    prompt_config
    download_or_build
    generate_keys
    setup_iptables
    create_systemd_service
    save_client_info
    print_summary
}

main "$@"
