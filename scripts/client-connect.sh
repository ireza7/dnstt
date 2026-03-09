#!/usr/bin/env bash
#
# client-connect.sh - dnstt + SSH Client Connection Helper
#
# Usage:
#   chmod +x client-connect.sh
#   ./client-connect.sh
#
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_header() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   dnstt + SSH Client Connection Helper       ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
}

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$ARCH" in
        x86_64)  GOARCH="amd64" ;;
        aarch64|arm64) GOARCH="arm64" ;;
        armv7*)  GOARCH="arm" ;;
        *)
            echo -e "${RED}Unsupported architecture: $ARCH${NC}"
            exit 1
            ;;
    esac

    case "$OS" in
        linux)  GOOS="linux"; SUFFIX="" ;;
        darwin) GOOS="darwin"; SUFFIX="" ;;
        mingw*|msys*|cygwin*)
            GOOS="windows"; SUFFIX=".exe" ;;
        *)
            echo -e "${RED}Unsupported OS: $OS${NC}"
            exit 1
            ;;
    esac

    echo -e "${GREEN}[✓]${NC} Platform: ${GOOS}-${GOARCH}"
}

download_client() {
    REPO_URL="${DNSTT_REPO_URL:-https://github.com/ireza7/dnstt}"
    RELEASE_URL="${REPO_URL}/releases/latest/download/dnstt-${GOOS}-${GOARCH}.tar.gz"

    if [ "$GOOS" = "windows" ]; then
        RELEASE_URL="${REPO_URL}/releases/latest/download/dnstt-${GOOS}-${GOARCH}.zip"
    fi

    echo -e "${BLUE}[*]${NC} Downloading from: $RELEASE_URL"

    if [ -f "dnstt-client${SUFFIX}" ]; then
        echo -e "${YELLOW}[!]${NC} dnstt-client already exists. Overwrite? (y/n)"
        read -r ans
        if [[ ! "$ans" =~ ^[Yy]$ ]]; then
            echo "Using existing binary."
            return
        fi
    fi

    if [ "$GOOS" = "windows" ]; then
        curl -fsSL "$RELEASE_URL" -o /tmp/dnstt.zip
        unzip -o /tmp/dnstt.zip -d .
        rm /tmp/dnstt.zip
    else
        curl -fsSL "$RELEASE_URL" -o /tmp/dnstt.tar.gz
        tar xzf /tmp/dnstt.tar.gz --strip-components=1
        rm /tmp/dnstt.tar.gz
    fi

    chmod +x "dnstt-client-${GOOS}-${GOARCH}${SUFFIX}" 2>/dev/null || true

    # Create a simpler name
    cp "dnstt-client-${GOOS}-${GOARCH}${SUFFIX}" "dnstt-client${SUFFIX}" 2>/dev/null || true

    echo -e "${GREEN}[✓]${NC} Downloaded dnstt-client"
}

prompt_config() {
    echo ""
    echo -e "${YELLOW}═══ Connection Settings ═══${NC}"
    echo ""

    read -rp "Tunnel domain (e.g., t.example.com): " TUNNEL_DOMAIN
    if [ -z "$TUNNEL_DOMAIN" ]; then
        echo -e "${RED}Domain cannot be empty${NC}"
        exit 1
    fi

    read -rp "Server public key (hex string): " PUBKEY
    if [ -z "$PUBKEY" ]; then
        if [ -f "server.pub" ]; then
            PUBKEY=$(cat server.pub)
            echo -e "${GREEN}[✓]${NC} Using key from server.pub: $PUBKEY"
        else
            echo -e "${RED}Public key is required${NC}"
            exit 1
        fi
    fi

    echo ""
    echo "Transport protocol:"
    echo "  1) DoH (DNS over HTTPS) - Recommended"
    echo "  2) DoT (DNS over TLS)"
    echo "  3) UDP (plaintext, for testing only)"
    read -rp "Choose [1]: " TRANSPORT
    TRANSPORT=${TRANSPORT:-1}

    case "$TRANSPORT" in
        1)
            echo ""
            echo "DoH resolver:"
            echo "  1) Cloudflare  (https://cloudflare-dns.com/dns-query)"
            echo "  2) Google      (https://dns.google/dns-query)"
            echo "  3) Quad9       (https://dns.quad9.net/dns-query)"
            echo "  4) Custom URL"
            read -rp "Choose [1]: " DOH_CHOICE
            DOH_CHOICE=${DOH_CHOICE:-1}
            case "$DOH_CHOICE" in
                1) RESOLVER_URL="https://cloudflare-dns.com/dns-query" ;;
                2) RESOLVER_URL="https://dns.google/dns-query" ;;
                3) RESOLVER_URL="https://dns.quad9.net/dns-query" ;;
                4) read -rp "Enter DoH URL: " RESOLVER_URL ;;
                *) RESOLVER_URL="https://cloudflare-dns.com/dns-query" ;;
            esac
            TRANSPORT_FLAG="-doh $RESOLVER_URL"
            ;;
        2)
            echo ""
            echo "DoT resolver:"
            echo "  1) Cloudflare  (1.1.1.1:853)"
            echo "  2) Google      (8.8.8.8:853)"
            echo "  3) Quad9       (9.9.9.9:853)"
            echo "  4) Custom"
            read -rp "Choose [1]: " DOT_CHOICE
            DOT_CHOICE=${DOT_CHOICE:-1}
            case "$DOT_CHOICE" in
                1) RESOLVER_URL="1.1.1.1:853" ;;
                2) RESOLVER_URL="8.8.8.8:853" ;;
                3) RESOLVER_URL="9.9.9.9:853" ;;
                4) read -rp "Enter DoT address (host:port): " RESOLVER_URL ;;
                *) RESOLVER_URL="1.1.1.1:853" ;;
            esac
            TRANSPORT_FLAG="-dot $RESOLVER_URL"
            ;;
        3)
            read -rp "DNS server address: " RESOLVER_URL
            TRANSPORT_FLAG="-udp $RESOLVER_URL"
            ;;
    esac

    LOCAL_PORT="${LOCAL_PORT:-2222}"
    read -rp "Local tunnel port [2222]: " LOCAL_PORT_INPUT
    LOCAL_PORT=${LOCAL_PORT_INPUT:-$LOCAL_PORT}

    read -rp "SSH username on server: " SSH_USER
    SSH_USER=${SSH_USER:-root}

    SOCKS_PORT="${SOCKS_PORT:-1080}"
    read -rp "Local SOCKS5 proxy port [1080]: " SOCKS_PORT_INPUT
    SOCKS_PORT=${SOCKS_PORT_INPUT:-$SOCKS_PORT}
}

save_pubkey() {
    echo "$PUBKEY" > server.pub
    echo -e "${GREEN}[✓]${NC} Public key saved to server.pub"
}

start_tunnel() {
    echo ""
    echo -e "${BLUE}[*]${NC} Starting dnstt tunnel..."
    echo ""
    echo -e "${CYAN}Command:${NC}"
    echo "  ./dnstt-client${SUFFIX} $TRANSPORT_FLAG -pubkey-file server.pub $TUNNEL_DOMAIN 127.0.0.1:$LOCAL_PORT"
    echo ""

    save_pubkey

    # Start tunnel in background
    ./dnstt-client${SUFFIX} $TRANSPORT_FLAG -pubkey-file server.pub "$TUNNEL_DOMAIN" "127.0.0.1:$LOCAL_PORT" &
    TUNNEL_PID=$!

    sleep 3

    if kill -0 $TUNNEL_PID 2>/dev/null; then
        echo -e "${GREEN}[✓]${NC} Tunnel started (PID: $TUNNEL_PID)"
    else
        echo -e "${RED}[✗]${NC} Tunnel failed to start"
        exit 1
    fi

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  Tunnel is running!                                         ║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║                                                              ║${NC}"
    echo -e "${GREEN}║  SSH through tunnel:                                         ║${NC}"
    echo -e "${GREEN}║    ssh -p $LOCAL_PORT $SSH_USER@127.0.0.1                    ║${NC}"
    echo -e "${GREEN}║                                                              ║${NC}"
    echo -e "${GREEN}║  SSH SOCKS Proxy:                                            ║${NC}"
    echo -e "${GREEN}║    ssh -N -D 127.0.0.1:$SOCKS_PORT -p $LOCAL_PORT $SSH_USER@127.0.0.1  ║${NC}"
    echo -e "${GREEN}║                                                              ║${NC}"
    echo -e "${GREEN}║  Then configure your browser SOCKS5 proxy:                   ║${NC}"
    echo -e "${GREEN}║    Host: 127.0.0.1  Port: $SOCKS_PORT                       ║${NC}"
    echo -e "${GREEN}║                                                              ║${NC}"
    echo -e "${GREEN}║  Stop tunnel: kill $TUNNEL_PID                               ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    echo -e "${YELLOW}Press Ctrl+C to stop the tunnel${NC}"
    wait $TUNNEL_PID
}

# --- Main ---
main() {
    print_header
    detect_platform

    if [ ! -f "dnstt-client${SUFFIX}" ] && [ ! -f "dnstt-client-${GOOS}-${GOARCH}${SUFFIX}" ]; then
        echo -e "${YELLOW}[!]${NC} dnstt-client not found locally."
        read -rp "Download from GitHub releases? (y/n): " DL
        if [[ "$DL" =~ ^[Yy]$ ]]; then
            download_client
        else
            echo -e "${RED}Please place dnstt-client in the current directory${NC}"
            exit 1
        fi
    fi

    prompt_config
    start_tunnel
}

main "$@"
