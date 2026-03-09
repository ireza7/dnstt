<div dir="rtl" align="right">

# راهنمای کامل راه‌اندازی dnstt + SSH

## تونل DNS رایگان با استفاده از GitHub

<div align="center">

**بدون نیاز به نصب Go | بدون نیاز به کامپایل دستی | فقط چند کلیک**

[![Build dnstt](../../actions/workflows/build-release.yml/badge.svg)](../../actions/workflows/build-release.yml)

</div>

---

## فهرست مطالب

- [dnstt چیست؟](#dnstt-چیست)
- [چطور کار می‌کنه؟](#چطور-کار-میکنه)
- [پیش‌نیازها](#پیشنیازها)
- [قدم ۱: فورک کردن و بیلد گرفتن](#قدم-۱-فورک-کردن-و-بیلد-گرفتن)
- [قدم ۲: تنظیم DNS دامنه](#قدم-۲-تنظیم-dns-دامنه)
- [قدم ۳: راه‌اندازی سرور](#قدم-۳-راهاندازی-سرور)
- [قدم ۴: اتصال کلاینت](#قدم-۴-اتصال-کلاینت)
- [استفاده به عنوان پروکسی](#استفاده-به-عنوان-پروکسی)
- [استفاده در اندروید](#استفاده-در-اندروید)
- [استفاده در ویندوز](#استفاده-در-ویندوز)
- [عیب‌یابی](#عیبیابی)
- [سوالات متداول](#سوالات-متداول)

---

## dnstt چیست؟

**dnstt** یک ابزار تونل DNS هست که ترافیک شما رو از طریق درخواست‌های DNS عبور می‌ده. از اونجایی که ترافیک DNS معمولاً مسدود نمیشه، این روش برای دور زدن فیلترینگ بسیار موثره.

### ویژگی‌ها:
- ✅ پشتیبانی از **DoH** (DNS over HTTPS) و **DoT** (DNS over TLS)
- ✅ رمزنگاری سرتاسری با پروتکل **Noise**
- ✅ بازارسال خودکار بسته‌های از دست رفته
- ✅ عملکرد بهینه با **KCP** و **smux**
- ✅ قابلیت عبور از اکثر فایروال‌ها

---

## چطور کار می‌کنه؟

```
شما (کلاینت)          اینترنت              سرور شما
┌──────────┐    ┌──────────────┐    ┌──────────┐
│  dnstt   │◄──►│ DNS Resolver │◄──►│  dnstt   │
│  client  │    │ (Cloudflare) │    │  server  │
└────┬─────┘    └──────────────┘    └────┬─────┘
     │                                    │
┌────┴─────┐                        ┌────┴─────┐
│ SSH/Apps │                        │   SSH    │
│          │                        │  Server  │
└──────────┘                        └──────────┘
```

**خلاصه:** ترافیک SSH شما به شکل درخواست‌های DNS عادی درمیاد و از طریق یک DNS Resolver عمومی (مثل Cloudflare) به سرور شما می‌رسه.

---

## پیش‌نیازها

| مورد | توضیح |
|------|-------|
| 🖥️ **یک VPS** | سرور لینوکس با IP ثابت (مثلاً از Hetzner, DigitalOcean, Vultr) |
| 🌐 **یک دامنه** | هر دامنه‌ای که بتونید DNS رکوردهاش رو تنظیم کنید |
| 📱 **اکانت GitHub** | برای فورک کردن و بیلد گرفتن رایگان |
| 💻 **دسترسی SSH** | برای اتصال به VPS |

---

## قدم ۱: فورک کردن و بیلد گرفتن

### ۱.۱ فورک کردن ریپو

1. به صفحه [این ریپو](../../) برید
2. دکمه **Fork** رو بزنید (بالا سمت راست)
3. صبر کنید تا ریپو توی اکانت شما کپی بشه

### ۱.۲ بیلد گرفتن با GitHub Actions

1. توی ریپوی فورک شده، به تب **Actions** برید
2. از لیست سمت چپ، **"Build dnstt Binaries"** رو انتخاب کنید
3. روی **"Run workflow"** کلیک کنید
4. یه تگ بزنید (مثلاً `v1.0.0`) یا همون `latest` رو بذارید
5. **"Run workflow"** رو بزنید

<div align="center">

```
┌─────────────────────────────────────────────┐
│  GitHub Actions                              │
│                                              │
│  📦 Build dnstt Binaries                     │
│                                              │
│  [Run workflow ▼]                            │
│    Branch: master                            │
│    Tag: v1.0.0                               │
│    [  Run workflow  ]                        │
│                                              │
└─────────────────────────────────────────────┘
```

</div>

### ۱.۳ دانلود فایل‌های بیلد شده

بعد از تموم شدن بیلد (حدود ۲-۳ دقیقه):

**روش ۱ - از Artifacts:**
1. روی workflow run کلیک کنید
2. پایین صفحه، بخش **Artifacts** رو ببینید
3. فایل مربوط به سیستم‌عامل خودتون رو دانلود کنید

**روش ۲ - از Releases:**
1. به تب **Releases** برید
2. آخرین ریلیز رو پیدا کنید
3. فایل مناسب سیستم‌عامل‌تون رو دانلود کنید

| فایل | سیستم‌عامل | معماری |
|------|-----------|--------|
| `dnstt-linux-amd64.tar.gz` | لینوکس | Intel/AMD 64-bit |
| `dnstt-linux-arm64.tar.gz` | لینوکس | ARM 64-bit (مثلاً Oracle ARM) |
| `dnstt-windows-amd64.zip` | ویندوز | Intel/AMD 64-bit |
| `dnstt-darwin-amd64.tar.gz` | مک | Intel |
| `dnstt-darwin-arm64.tar.gz` | مک | Apple Silicon (M1/M2/M3) |

### ⚠️ فایل‌های مهم داخل آرشیو

| فایل | توضیح | کجا لازمه؟ |
|------|-------|-----------|
| `dnstt-server-*` | باینری سرور | فقط روی VPS |
| `dnstt-client-*` | باینری کلاینت | روی دستگاه شما |
| `server.pub` | کلید عمومی | هم سرور هم کلاینت |
| `server.key` | 🔐 کلید خصوصی | **فقط روی VPS** - هرگز به اشتراک نذارید! |

---

## قدم ۲: تنظیم DNS دامنه

فرض کنیم:
- **دامنه شما:** `example.com`
- **IP سرور:** `1.2.3.4`

### رکوردهای DNS لازم

به پنل مدیریت DNS دامنه‌تون برید و این رکوردها رو اضافه کنید:

| نوع | نام | مقدار | توضیح |
|-----|-----|-------|-------|
| **A** | `tns` | `1.2.3.4` | آدرس سرور تونل |
| **NS** | `t` | `tns.example.com` | واگذاری ساب‌دامین به سرور تونل |

### ✅ تست DNS

بعد از تنظیم (ممکنه تا ۲۴ ساعت طول بکشه، ولی معمولاً چند دقیقه‌ایه):

```bash
# تست A رکورد
dig +short tns.example.com
# باید 1.2.3.4 رو نشون بده

# تست NS رکورد
dig +short NS t.example.com
# باید tns.example.com رو نشون بده
```

### 💡 نکات مهم DNS

- لیبل `t` رو **کوتاه** انتخاب کنید (هر کاراکتر فضای کمتری برای دیتا می‌ذاره)
- `tns` **نباید** زیردامنه `t` باشه (مثلاً `tns.t.example.com` ❌)
- اگه از Cloudflare استفاده می‌کنید، **پروکسی رو خاموش کنید** (ابر نارنجی → خاکستری)

---

## قدم ۳: راه‌اندازی سرور

### روش سریع (با اسکریپت)

```bash
# دانلود و اجرای اسکریپت نصب
wget https://raw.githubusercontent.com/YOUR_USERNAME/dnstt/master/scripts/server-setup.sh
chmod +x server-setup.sh
sudo ./server-setup.sh
```

### روش دستی (قدم به قدم)

#### ۳.۱ آپلود فایل‌ها به سرور

```bash
# از کامپیوتر خودتون:
scp dnstt-linux-amd64.tar.gz root@1.2.3.4:/root/
```

#### ۳.۲ استخراج و نصب

```bash
# روی سرور:
ssh root@1.2.3.4

# استخراج
mkdir -p /opt/dnstt
cd /opt/dnstt
tar xzf /root/dnstt-linux-amd64.tar.gz --strip-components=1

# تغییر نام برای راحتی
mv dnstt-server-linux-amd64 dnstt-server
mv dnstt-client-linux-amd64 dnstt-client
chmod +x dnstt-server dnstt-client
```

#### ۳.۳ تولید کلید رمزنگاری

> ⚠️ **اگه از GitHub Actions بیلد گرفتید، فایل‌های `server.key` و `server.pub` از قبل وجود دارن.**
> ولی اگه می‌خواید کلید جدید بسازید:

```bash
cd /opt/dnstt
./dnstt-server -gen-key -privkey-file server.key -pubkey-file server.pub
```

**کلید عمومی رو یادداشت کنید** - بعداً برای کلاینت لازم دارید:
```bash
cat server.pub
# خروجی مثلاً: 0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff
```

#### ۳.۴ تنظیم iptables

```bash
# فوروارد پورت 53 به 5300
sudo iptables -I INPUT -p udp --dport 5300 -j ACCEPT
sudo iptables -t nat -I PREROUTING -i eth0 -p udp --dport 53 -j REDIRECT --to-ports 5300

# برای IPv6 هم
sudo ip6tables -I INPUT -p udp --dport 5300 -j ACCEPT
sudo ip6tables -t nat -I PREROUTING -i eth0 -p udp --dport 53 -j REDIRECT --to-ports 5300
```

> 💡 **نکته:** اگه اینترفیس شبکه شما `eth0` نیست، اسم درست رو با `ip a` پیدا کنید.

#### ۳.۵ اجرای سرور (اتصال به SSH)

```bash
# اجرای dnstt-server که ترافیک رو به SSH (پورت 22) فوروارد کنه
cd /opt/dnstt
./dnstt-server -udp :5300 -privkey-file server.key t.example.com 127.0.0.1:22
```

#### ۳.۶ اجرا به صورت سرویس (پیشنهادی)

برای اینکه سرور بعد از ری‌استارت هم اجرا بشه:

```bash
sudo tee /etc/systemd/system/dnstt-server.service << 'EOF'
[Unit]
Description=dnstt DNS Tunnel Server
After=network.target

[Service]
Type=simple
ExecStart=/opt/dnstt/dnstt-server -udp :5300 -privkey-file /opt/dnstt/server.key t.example.com 127.0.0.1:22
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dnstt-server

# چک وضعیت:
sudo systemctl status dnstt-server
```

---

## قدم ۴: اتصال کلاینت

### لینوکس / مک

```bash
# استخراج فایل
tar xzf dnstt-linux-amd64.tar.gz    # یا darwin-arm64 برای مک M1+
cd dnstt-linux-amd64

# کپی کلید عمومی
echo "PUBKEY_HEX_FROM_SERVER" > server.pub

# اجرای تونل (DoH با Cloudflare)
chmod +x dnstt-client-linux-amd64
./dnstt-client-linux-amd64 \
  -doh https://cloudflare-dns.com/dns-query \
  -pubkey-file server.pub \
  t.example.com 127.0.0.1:2222
```

حالا یه ترمینال دیگه باز کنید و از SSH استفاده کنید:

```bash
# اتصال SSH از طریق تونل
ssh -p 2222 root@127.0.0.1

# یا با SOCKS Proxy (برای مرورگر)
ssh -N -D 127.0.0.1:1080 -p 2222 root@127.0.0.1
```

### استفاده از اسکریپت کمکی

```bash
wget https://raw.githubusercontent.com/YOUR_USERNAME/dnstt/master/scripts/client-connect.sh
chmod +x client-connect.sh
./client-connect.sh
```

---

## استفاده به عنوان پروکسی

بعد از اتصال SSH از طریق تونل، یه **SOCKS5 Proxy** روی سیستم شما ایجاد می‌شه:

### مرورگر Firefox

1. `Settings` → `Network Settings` → `Settings`
2. `Manual proxy configuration` رو انتخاب کنید
3. `SOCKS Host`: `127.0.0.1` | `Port`: `1080`
4. `SOCKS v5` رو انتخاب کنید
5. ✅ `Proxy DNS when using SOCKS v5`

### مرورگر Chrome

```bash
# لینوکس/مک
google-chrome --proxy-server="socks5://127.0.0.1:1080"

# یا از افزونه SwitchyOmega استفاده کنید
```

### کل سیستم (لینوکس)

```bash
export ALL_PROXY=socks5://127.0.0.1:1080
export HTTP_PROXY=socks5://127.0.0.1:1080
export HTTPS_PROXY=socks5://127.0.0.1:1080
```

### تست اتصال

```bash
curl --proxy socks5h://127.0.0.1:1080 https://ifconfig.me
# باید IP سرور شما رو نشون بده
```

---

## استفاده در اندروید

### پیش‌نیاز
- اپلیکیشن [Termux](https://f-droid.org/packages/com.termux/) (از F-Droid دانلود کنید، نه Play Store)

### مراحل

```bash
# ۱. نصب پیش‌نیازها در Termux
pkg update && pkg install openssh wget

# ۲. دانلود باینری ARM64
wget https://github.com/YOUR_USERNAME/dnstt/releases/latest/download/dnstt-linux-arm64.tar.gz
tar xzf dnstt-linux-arm64.tar.gz
cd dnstt-linux-arm64

# ۳. ذخیره کلید عمومی
echo "PUBKEY_HEX" > server.pub

# ۴. اجرای تونل
chmod +x dnstt-client-linux-arm64
./dnstt-client-linux-arm64 \
  -doh https://cloudflare-dns.com/dns-query \
  -pubkey-file server.pub \
  t.example.com 127.0.0.1:2222
```

بعد یه session جدید Termux باز کنید:

```bash
# ۵. SSH SOCKS Proxy
ssh -N -D 127.0.0.1:1080 -p 2222 root@127.0.0.1
```

حالا از اپ **"Proxy Settings"** یا هر اپ پروکسی دیگه‌ای استفاده کنید و SOCKS5 رو روی `127.0.0.1:1080` تنظیم کنید.

---

## استفاده در ویندوز

### ۱. دانلود و استخراج

فایل `dnstt-windows-amd64.zip` رو از [Releases](../../releases) دانلود و استخراج کنید.

### ۲. ذخیره کلید عمومی

فایل `server.pub` رو توی همون فولدر بذارید (یا محتویات کلید عمومی رو توش ذخیره کنید).

### ۳. اجرا از PowerShell

```powershell
cd C:\path\to\dnstt

# اجرای تونل
.\dnstt-client-windows-amd64.exe `
  -doh https://cloudflare-dns.com/dns-query `
  -pubkey-file server.pub `
  t.example.com 127.0.0.1:2222
```

### ۴. اتصال SSH

از [PuTTY](https://www.putty.org/) یا OpenSSH ویندوز استفاده کنید:

```powershell
# PowerShell
ssh -p 2222 root@127.0.0.1

# SOCKS Proxy
ssh -N -D 127.0.0.1:1080 -p 2222 root@127.0.0.1
```

### ۵. تنظیم پروکسی ویندوز

1. `Settings` → `Network & Internet` → `Proxy`
2. یا از مرورگر: `Internet Options` → `Connections` → `LAN Settings`
3. SOCKS5: `127.0.0.1:1080`

---

## انتخاب DoH Resolver

| ارائه‌دهنده | آدرس DoH | آدرس DoT | پیشنهاد |
|------------|----------|----------|---------|
| Cloudflare | `https://cloudflare-dns.com/dns-query` | `1.1.1.1:853` | ⭐ بهترین |
| Google | `https://dns.google/dns-query` | `8.8.8.8:853` | خوب |
| Quad9 | `https://dns.quad9.net/dns-query` | `9.9.9.9:853` | خوب |
| AdGuard | `https://dns.adguard-dns.com/dns-query` | `94.140.14.14:853` | خوب |
| Mullvad | `https://dns.mullvad.net/dns-query` | `194.242.2.2:853` | عالی |

> 💡 **نکته:** اگه یه resolver کار نکرد، یکی دیگه رو امتحان کنید.

---

## عیب‌یابی

### تونل وصل نمیشه

```bash
# ۱. چک کنید DNS درسته
dig +short tns.example.com
# باید IP سرور رو برگردونه

dig +short NS t.example.com
# باید tns.example.com رو برگردونه

# ۲. چک کنید سرور داره گوش می‌ده
sudo ss -ulnp | grep 5300

# ۳. چک کنید پورت 53 فوروارد شده
sudo iptables -t nat -L -n | grep 53

# ۴. چک کنید فایروال سرور
sudo ufw status  # Ubuntu
sudo firewall-cmd --list-all  # CentOS/Fedora
```

### سرعت پایینه

- DNS tunneling ذاتاً کنده (معمولاً ۵۰-۱۵۰ KB/s)
- resolver نزدیک‌تر به سرور انتخاب کنید
- از `-mtu 1452` روی سرور استفاده کنید (ممکنه سرعت بره بالا)
- طول دامنه رو کم کنید (مثلاً `t.ex.co` بهتر از `tunnel.example.com`)

### خطای "connection refused"

```bash
# مطمئن بشید SSH روی سرور فعاله
sudo systemctl status sshd

# مطمئن بشید dnstt-server به پورت 22 فوروارد می‌کنه
# (نه به پورت دیگه‌ای)
```

### خطای "pubkey mismatch"

کلید عمومی روی کلاینت باید دقیقاً مطابق سرور باشه:
```bash
# روی سرور:
cat /opt/dnstt/server.pub

# همین مقدار رو روی کلاینت بذارید
```

---

## سوالات متداول

<details>
<summary><b>آیا این کار قانونیه؟</b></summary>

dnstt یک ابزار متن‌باز برای ایجاد تونل DNS هست. استفاده از اون بستگی به قوانین کشور شما داره. این ابزار اصلاً برای اهداف تحقیقاتی و دور زدن سانسور ساخته شده.
</details>

<details>
<summary><b>چقدر سرعت داره؟</b></summary>

سرعت DNS tunneling معمولاً بین ۵۰ تا ۱۵۰ KB/s هست. برای مرور وب و پیام‌رسانی مناسبه ولی برای دانلود فایل‌های بزرگ یا تماشای ویدیو مناسب نیست.
</details>

<details>
<summary><b>آیا قابل شناسایی هست؟</b></summary>

استفاده از DoH باعث می‌شه ترافیک شما شبیه HTTPS عادی به نظر برسه. ولی حجم بالای درخواست‌های DNS ممکنه مشکوک باشه. برای امنیت بیشتر:
- از DoH استفاده کنید (نه DoT یا UDP)
- حجم ترافیک رو معقول نگه دارید
- از دامنه‌های کوتاه و طبیعی استفاده کنید
</details>

<details>
<summary><b>چطور می‌تونم کلید رو عوض کنم؟</b></summary>

```bash
# روی سرور:
cd /opt/dnstt
./dnstt-server -gen-key -privkey-file server.key -pubkey-file server.pub
sudo systemctl restart dnstt-server

# کلید جدید رو به کلاینت‌ها بدید
cat server.pub
```
</details>

<details>
<summary><b>آیا می‌تونم چند کلاینت همزمان وصل کنم؟</b></summary>

بله! dnstt از session multiplexing پشتیبانی می‌کنه و چندین کلاینت می‌تونن همزمان متصل بشن.
</details>

<details>
<summary><b>آیا GitHub Actions رایگانه؟</b></summary>

بله! برای ریپوهای عمومی (public)، GitHub Actions کاملاً رایگانه و ماهانه ۲۰۰۰ دقیقه زمان بیلد داره.
</details>

---

## خلاصه سریع

```
┌─────────────────────────────────────────────────────────┐
│                    خلاصه مراحل                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ۱. فورک ریپو + Run Workflow → دانلود باینری‌ها         │
│                                                         │
│  ۲. DNS تنظیم:                                          │
│     A    tns.example.com → IP سرور                      │
│     NS   t.example.com   → tns.example.com              │
│                                                         │
│  ۳. سرور:                                               │
│     ./dnstt-server -udp :5300 \                         │
│       -privkey-file server.key \                        │
│       t.example.com 127.0.0.1:22                        │
│                                                         │
│  ۴. کلاینت:                                              │
│     ./dnstt-client \                                    │
│       -doh https://cloudflare-dns.com/dns-query \       │
│       -pubkey-file server.pub \                         │
│       t.example.com 127.0.0.1:2222                      │
│                                                         │
│  ۵. SSH:                                                │
│     ssh -p 2222 root@127.0.0.1                          │
│                                                         │
│  ۶. پروکسی SOCKS5:                                      │
│     ssh -N -D 1080 -p 2222 root@127.0.0.1               │
│     → مرورگر: SOCKS5 127.0.0.1:1080                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## امنیت

> ⚠️ **هشدار:** فایل `server.key` (کلید خصوصی) رو **هرگز** به کسی ندید و جایی آپلود نکنید!

- ✅ `server.pub` (کلید عمومی) رو می‌تونید آزادانه به اشتراک بذارید
- ❌ `server.key` (کلید خصوصی) باید فقط روی سرور باشه
- 🔒 ترافیک بین کلاینت و سرور رمزنگاری شده (Noise protocol)
- 🔒 از DoH استفاده کنید تا ترافیک DNS هم رمزنگاری بشه

---

## مشارکت

اگه باگی پیدا کردید یا پیشنهادی دارید، لطفاً یه [Issue](../../issues) باز کنید یا Pull Request بفرستید.

## لایسنس

این پروژه تحت لایسنس **Public Domain** منتشر شده.

</div>
