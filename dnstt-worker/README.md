# dnstt-worker

A port of [dnstt](https://www.bamsoftware.com/software/dnstt/) DNS tunnel server to run as a **Cloudflare Worker**, providing a DNS-over-HTTPS (DoH) endpoint for the tunnel.

## One-Click Deploy

Deploy your own dnstt DoH server to Cloudflare Workers in seconds:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ireza7/dnstt/tree/master/dnstt-worker)

> After clicking the button, Cloudflare will clone this repo into your GitHub account and deploy the worker automatically. You'll need to configure the environment variables (see [Configuration](#configuration) below).

## Overview

dnstt is a DNS tunnel with support for DoH (DNS over HTTPS) and DoT (DNS over TLS). This project adapts the server-side component to run entirely on Cloudflare Workers, eliminating the need for a dedicated server to handle DoH queries.

### How It Works

```
                         Censored Network                    Free Internet
                    ┌─────────────────────┐           ┌──────────────────────┐
                    │                     │           │                      │
  ┌──────────┐     │   ┌───────────────┐  │           │  ┌────────────────┐  │
  │  dnstt   │ DoH │   │  Cloudflare   │  │  UDP DNS  │  │  dnstt-server  │  │
  │  client  │────────►│  Worker (DoH) │──────────────►  │  (your VPS)    │  │
  │          │◄────────│  dnstt-worker  │◄──────────────  │                │  │
  └──────────┘     │   └───────────────┘  │           │  └───────┬────────┘  │
       │           │                      │           │          │           │
  ┌──────────┐     │    🔒 HTTPS tunnel   │           │     ┌────▼─────┐     │
  │   SSH /  │     │    looks like normal │           │     │  SSH /   │     │
  │  Browser │     │    DNS traffic       │           │     │  Proxy   │     │
  └──────────┘     │                      │           │     └──────────┘     │
                    └─────────────────────┘           └──────────────────────┘
```

1. The dnstt client encodes tunnel data into DNS query names using base32
2. Queries are sent as DoH (HTTPS) requests to the Cloudflare Worker
3. From an observer's perspective, this looks like normal HTTPS traffic to Cloudflare
4. The Worker processes the DNS query and forwards it to the resolver
5. The resolver contacts your dnstt-server (acting as authoritative DNS)
6. Data flows back through the same path in reverse

### Components

The worker includes JavaScript ports of the core dnstt modules:

| Module | Description |
|--------|-------------|
| `src/dns.js` | DNS wire format encoder/decoder (RFC 1035) |
| `src/noise.js` | Noise_NK_25519_ChaChaPoly_BLAKE2s protocol |
| `src/kcp.js` | KCP reliable transport protocol |
| `src/turbotunnel.js` | Session management (ClientID, sessions) |
| `src/index.js` | Main Worker: DoH endpoint (RFC 8484) |

## Setup

### Prerequisites

- A Cloudflare account (free tier works)
- A domain name
- A VPS (Virtual Private Server) for running dnstt-server

### Step 1: Deploy the Worker

**Option A: One-Click Deploy (Recommended)**

Click the Deploy to Cloudflare button above. This will:
1. Fork this repo to your GitHub account
2. Deploy the worker to your Cloudflare account
3. Set up CI/CD for future updates

**Option B: Manual Deploy**

```bash
cd dnstt-worker
npm install
npx wrangler login
npx wrangler deploy
```

### Step 2: Configure DNS Records

Add these DNS records at your domain registrar:

| Type | Name | Value |
|------|------|-------|
| A | `tns.example.com` | `<your VPS IP>` |
| AAAA | `tns.example.com` | `<your VPS IPv6>` (optional) |
| NS | `t.example.com` | `tns.example.com` |

### Step 3: Generate Keys

On your VPS:

```bash
cd dnstt-server && go build
./dnstt-server -gen-key -privkey-file server.key -pubkey-file server.pub
cat server.key   # This is your DNSTT_PRIVKEY (hex)
cat server.pub   # Share this with clients
```

### Step 4: Configure the Worker

Set the environment variables in Cloudflare Dashboard → Workers → your worker → Settings → Variables:

| Variable | Value | Type |
|----------|-------|------|
| `DNSTT_DOMAIN` | `t.example.com` | Plain text |
| `DNSTT_PRIVKEY` | `<hex from server.key>` | **Encrypted** (secret) |
| `DNSTT_MTU` | `1232` | Plain text |

Or use Wrangler CLI:

```bash
wrangler secret put DNSTT_PRIVKEY
```

### Step 5: Set Up VPS (dnstt-server)

```bash
# Install Go
wget https://go.dev/dl/go1.22.0.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.22.0.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin

# Build dnstt-server
git clone https://www.bamsoftware.com/git/dnstt.git
cd dnstt/dnstt-server && go build

# Set up firewall (redirect port 53 → 5300)
sudo iptables -I INPUT -p udp --dport 5300 -j ACCEPT
sudo iptables -t nat -I PREROUTING -i eth0 -p udp --dport 53 -j REDIRECT --to-ports 5300

# Run the server (forwards tunnel to SSH)
./dnstt-server -udp :5300 -privkey-file server.key t.example.com 127.0.0.1:22
```

### Step 6: Connect from Client

```bash
# Build dnstt-client
cd dnstt/dnstt-client && go build

# Connect using your Cloudflare Worker as DoH resolver
./dnstt-client -doh https://your-worker.workers.dev/dns-query \
  -pubkey-file server.pub \
  t.example.com \
  127.0.0.1:8000

# SSH through the tunnel
ssh -o HostKeyAlias=your-server -p 8000 user@127.0.0.1

# Or create a SOCKS proxy
ssh -N -D 127.0.0.1:1080 -o HostKeyAlias=your-server -p 8000 user@127.0.0.1
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dns-query` | GET/POST | DoH endpoint (RFC 8484) |
| `/health` | GET | Health check with session count |
| `/info` | GET | Configuration info |
| `/` | GET | Usage information |

### DoH Query Format

**POST** (recommended):
```
POST /dns-query
Content-Type: application/dns-message
Body: <raw DNS query>
```

**GET**:
```
GET /dns-query?dns=<base64url-encoded DNS query>
```

## Development

### Run Locally

```bash
cd dnstt-worker
npm install
npm run dev
```

### Run Tests

```bash
npm test
```

## Security

- End-to-end encryption via Noise_NK_25519_ChaChaPoly_BLAKE2s
- Server authentication by public key
- No plaintext tunnel data visible to Cloudflare or any intermediary
- All crypto implemented in pure JavaScript (no external dependencies)

## Limitations

- **Stateless Workers**: Session state is maintained within the worker isolate but may be lost during deployments or edge migrations
- **Execution Time**: Workers have a CPU time limit (10ms on free plan, 50ms on paid)
- **No Raw TCP**: Workers cannot make raw TCP connections; upstream must be HTTP/WebSocket
- **No UDP**: Workers don't support UDP; this is a DoH-only server

## License

Public domain (same as original dnstt)

## Credits

Based on [dnstt](https://www.bamsoftware.com/software/dnstt/) by David Fifield.
