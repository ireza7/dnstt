<div dir="rtl" align="right">

# راهنمای کامل راه‌اندازی dnstt + SSH با Cloudflare Worker

## تانل DNS چیست و چرا مهم است؟

<div dir="rtl">

dnstt یک تانل DNS است که ترافیک شما را داخل درخواست‌های DNS رمزنگاری‌شده (DoH) پنهان می‌کند. از دید ناظر شبکه، ترافیک شما دقیقاً شبیه درخواست‌های DNS عادی به سرورهای Cloudflare به نظر می‌رسد.

</div>

```
شما (ایران)                    Cloudflare                     سرور شما (خارج)
┌──────────┐     HTTPS       ┌──────────────┐    UDP DNS    ┌──────────────┐
│  dnstt   │ ──────────────► │  Cloudflare  │ ────────────► │ dnstt-server │
│  client  │ ◄────────────── │   Worker     │ ◄──────────── │   (VPS)      │
└──────────┘   به نظر DNS    └──────────────┘               └──────┬───────┘
     │          عادی میاد                                          │
┌──────────┐                                                 ┌─────▼──────┐
│ مرورگر  │                                                 │    SSH     │
│  /اپ    │                                                 │  سرور     │
└──────────┘                                                 └────────────┘
```

## پیش‌نیازها

<div dir="rtl">

قبل از شروع، مطمئن بشید این‌ها رو دارید:

</div>

| # | پیش‌نیاز | توضیحات |
|---|----------|---------|
| 1 | **اکانت Cloudflare** | رایگان - [ثبت‌نام](https://dash.cloudflare.com/sign-up) |
| 2 | **اکانت GitHub** | رایگان - [ثبت‌نام](https://github.com/signup) |
| 3 | **یک دامنه** | می‌تونه رایگان باشه (مثل freenom) یا خریداری شده |
| 4 | **یک VPS (سرور مجازی)** | خارج از ایران - حتی ارزان‌ترین پلن کافیه |

---

## مرحله ۱: دیپلوی Worker روی Cloudflare (یک کلیک!)

<div dir="rtl">

این ساده‌ترین مرحله‌ست. دکمه زیر رو بزنید:

</div>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ireza7/dnstt/tree/master/dnstt-worker)

<div dir="rtl">

### بعد از کلیک:

1. **وارد اکانت Cloudflare بشید** (یا ثبت‌نام کنید)
2. **اکانت GitHub رو وصل کنید** - Cloudflare یه کپی از ریپو رو توی GitHub شما می‌سازه
3. **اسم Worker رو انتخاب کنید** - مثلاً `my-dnstt` (آدرس نهایی: `my-dnstt.your-name.workers.dev`)
4. **Save and Deploy رو بزنید**

بعد از چند ثانیه، Worker شما آماده‌ست! آدرسش رو یادداشت کنید:

</div>

```
https://my-dnstt.your-name.workers.dev
```

<div dir="rtl">

> **تست سریع:** توی مرورگر برید به `https://my-dnstt.your-name.workers.dev/health` - باید یه JSON ببینید.

</div>

---

## مرحله ۲: تنظیمات DNS دامنه

<div dir="rtl">

فرض کنید دامنه شما `example.com` و IP سرور VPS شما `1.2.3.4` هست.

برید توی پنل مدیریت DNS دامنه‌تون (Cloudflare DNS، Namecheap، یا هر جایی که دامنه رو خریدید) و این رکوردها رو اضافه کنید:

</div>

| نوع رکورد | نام (Name) | مقدار (Value) | توضیح |
|-----------|------------|---------------|-------|
| `A` | `tns.example.com` | `1.2.3.4` | IP سرور VPS شما |
| `AAAA` | `tns.example.com` | `IPv6 سرور` | اختیاری - اگه سرور IPv6 داره |
| `NS` | `t.example.com` | `tns.example.com` | **مهم!** این رکورد به DNS resolver میگه برای `t.example.com` به سرور شما مراجعه کنه |

<div dir="rtl">

> **نکته:** به جای `tns` و `t` می‌تونید هر اسمی بذارید، ولی:
> - اسم `t` باید **کوتاه** باشه (چون فضای DNS محدوده)
> - `tns` **نباید** زیردامنه `t` باشه

> **مثال:** اگه دامنه شما `mysite.ir` باشه:
> - `A    tns.mysite.ir  →  1.2.3.4`
> - `NS   t.mysite.ir    →  tns.mysite.ir`

</div>

---

## مرحله ۳: راه‌اندازی سرور (VPS)

<div dir="rtl">

با SSH به سرور VPS وصل بشید و مراحل زیر رو دنبال کنید:

</div>

### روش سریع (اسکریپت خودکار)

```bash
wget -O setup-server.sh https://raw.githubusercontent.com/ireza7/dnstt/master/scripts/setup-server.sh
sudo bash setup-server.sh
```

### روش دستی (قدم به قدم)

#### ۳.۱ - نصب Go

```bash
# دانلود Go
wget https://go.dev/dl/go1.22.5.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.22.5.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc

# تست
go version
# باید ببینید: go version go1.22.5 linux/amd64
```

#### ۳.۲ - بیلد dnstt-server

```bash
git clone https://www.bamsoftware.com/git/dnstt.git
cd dnstt/dnstt-server
go build
```

#### ۳.۳ - ساخت کلید رمزنگاری

```bash
./dnstt-server -gen-key -privkey-file server.key -pubkey-file server.pub
```

<div dir="rtl">

دو فایل ساخته میشه:
- **`server.key`** = کلید خصوصی (Private Key) → برای Worker و سرور
- **`server.pub`** = کلید عمومی (Public Key) → برای کلاینت

**کلید خصوصی رو ببینید و کپی کنید** (برای مرحله بعد لازمه):

</div>

```bash
cat server.key
# خروجی مثلاً: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

#### ۳.۴ - تنظیم فایروال (ریدایرکت پورت 53)

```bash
# اجازه دسترسی به پورت 5300
sudo iptables -I INPUT -p udp --dport 5300 -j ACCEPT

# ریدایرکت پورت 53 (DNS) به 5300
sudo iptables -t nat -I PREROUTING -i eth0 -p udp --dport 53 -j REDIRECT --to-ports 5300

# همین کار برای IPv6
sudo ip6tables -I INPUT -p udp --dport 5300 -j ACCEPT
sudo ip6tables -t nat -I PREROUTING -i eth0 -p udp --dport 53 -j REDIRECT --to-ports 5300

# ذخیره قوانین فایروال (Ubuntu/Debian)
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

<div dir="rtl">

> **نکته:** اگه اینترفیس شبکه شما `eth0` نیست (مثلاً `ens3` یا `enp0s1`)، اسمش رو عوض کنید. با `ip addr` می‌تونید ببینید.

</div>

#### ۳.۵ - اجرای dnstt-server

```bash
# تانل DNS → SSH (پورت 22)
./dnstt-server -udp :5300 -privkey-file server.key t.example.com 127.0.0.1:22
```

<div dir="rtl">

> **`t.example.com`** رو با دامنه خودتون عوض کنید!

برای اجرای دائمی (بعد از بستن ترمینال هم کار کنه):

</div>

```bash
# روش 1: screen
screen -S dnstt
./dnstt-server -udp :5300 -privkey-file server.key t.example.com 127.0.0.1:22
# بزنید Ctrl+A سپس D برای جدا شدن از screen

# روش 2: systemd (بهتر و خودکار)
sudo tee /etc/systemd/system/dnstt-server.service << 'EOF'
[Unit]
Description=dnstt DNS Tunnel Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/dnstt/dnstt-server
ExecStart=/root/dnstt/dnstt-server/dnstt-server -udp :5300 -privkey-file /root/dnstt/dnstt-server/server.key t.example.com 127.0.0.1:22
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable dnstt-server
sudo systemctl start dnstt-server

# بررسی وضعیت
sudo systemctl status dnstt-server
```

---

## مرحله ۴: تنظیم کلید خصوصی در Worker

<div dir="rtl">

حالا باید کلید خصوصی (private key) رو به Worker اضافه کنید:

</div>

### روش ۱: از داشبورد Cloudflare (آسان‌تر)

<div dir="rtl">

1. وارد [Cloudflare Dashboard](https://dash.cloudflare.com) بشید
2. برید به **Workers & Pages**
3. روی Worker خودتون کلیک کنید
4. برید به تب **Settings** → **Variables and Secrets**
5. این متغیرها رو تنظیم کنید:

</div>

| نام متغیر | مقدار | نوع |
|-----------|-------|-----|
| `DNSTT_DOMAIN` | `t.example.com` | Plain text |
| `DNSTT_PRIVKEY` | `0123...abcdef` (کلید خصوصی hex) | **Encrypt** ✓ |
| `DNSTT_MTU` | `1232` | Plain text |

### روش ۲: با Wrangler CLI

```bash
# نصب wrangler
npm install -g wrangler
wrangler login

# تنظیم کلید خصوصی به صورت secret
wrangler secret put DNSTT_PRIVKEY
# کلید خصوصی رو paste کنید
```

---

## مرحله ۵: تنظیم کلاینت

### لینوکس

#### روش سریع (اسکریپت)

```bash
wget -O setup-client.sh https://raw.githubusercontent.com/ireza7/dnstt/master/scripts/setup-client.sh
bash setup-client.sh
```

#### روش دستی

```bash
# نصب Go و بیلد
git clone https://www.bamsoftware.com/git/dnstt.git
cd dnstt/dnstt-client
go build

# کپی server.pub از سرور (یا دستی بسازیدش)
scp user@your-server:~/dnstt/dnstt-server/server.pub .

# اجرای تانل
./dnstt-client -doh https://my-dnstt.your-name.workers.dev/dns-query \
  -pubkey-file server.pub \
  t.example.com \
  127.0.0.1:8000
```

### ویندوز

<div dir="rtl">

1. **Go رو نصب کنید:** از [go.dev/dl](https://go.dev/dl) فایل Windows رو دانلود و نصب کنید

2. **dnstt رو دانلود کنید:** از [اینجا](https://www.bamsoftware.com/software/dnstt/) آخرین نسخه zip رو بگیرید

3. **بیلد کنید:** Command Prompt باز کنید:

</div>

```cmd
cd Downloads\dnstt\dnstt-client
go build
```

<div dir="rtl">

4. **فایل `server.pub` رو کنار `dnstt-client.exe` بذارید**

5. **اجرا کنید:**

</div>

```cmd
dnstt-client.exe -doh https://my-dnstt.your-name.workers.dev/dns-query -pubkey-file server.pub t.example.com 127.0.0.1:8000
```

### اندروید

<div dir="rtl">

برای اندروید می‌تونید از اپ [SlipNet](https://github.com/anonvector/SlipNet) استفاده کنید که از dnstt پشتیبانی می‌کنه.

</div>

---

## مرحله ۶: اتصال SSH و ساخت پروکسی SOCKS

<div dir="rtl">

بعد از اینکه تانل اجرا شد (مرحله ۵)، یه ترمینال جدید باز کنید:

</div>

### SSH معمولی

```bash
ssh -o HostKeyAlias=your-server -p 8000 user@127.0.0.1
```

### پروکسی SOCKS5 (برای مرورگر)

```bash
ssh -N -D 127.0.0.1:1080 -o HostKeyAlias=your-server -p 8000 user@127.0.0.1
```

<div dir="rtl">

> **`your-server`** رو با IP یا hostname واقعی سرورتون عوض کنید.
> **`user`** رو با نام کاربری SSH عوض کنید.

</div>

### تنظیم مرورگر

#### فایرفاکس

<div dir="rtl">

1. **Settings** → **General** → **Network Settings** → **Settings**
2. **Manual proxy configuration** رو انتخاب کنید
3. **SOCKS Host:** `127.0.0.1` — **Port:** `1080`
4. **SOCKS v5** رو انتخاب کنید
5. ☑️ **Proxy DNS when using SOCKS v5** رو تیک بزنید

</div>

#### کروم / اج

```bash
# لینوکس
google-chrome --proxy-server="socks5://127.0.0.1:1080"

# یا استفاده از SwitchyOmega extension
```

### تست اتصال

```bash
# باید IP سرور VPS شما رو نشون بده
curl --proxy socks5h://127.0.0.1:1080/ https://ifconfig.me
```

---

## عیب‌یابی (Troubleshooting)

### Worker جواب نمیده

<div dir="rtl">

- آدرس Worker رو چک کنید: `https://your-worker.workers.dev/health`
- مطمئن بشید `DNSTT_DOMAIN` و `DNSTT_PRIVKEY` درست تنظیم شده

</div>

### تانل وصل نمیشه

<div dir="rtl">

- رکوردهای DNS رو چک کنید: `dig NS t.example.com`
- مطمئن بشید dnstt-server روی VPS اجرا شده: `systemctl status dnstt-server`
- فایروال رو چک کنید: `sudo iptables -L -t nat`
- پورت 53 UDP باید باز باشه

</div>

### SSH وصل نمیشه

<div dir="rtl">

- مطمئن بشید SSH server روی VPS فعاله: `systemctl status sshd`
- `HostKeyAlias` باید همون hostname/IP باشه که قبلاً SSH زدید
- اول بار ممکنه host key verification بخواد

</div>

### سرعت کمه

<div dir="rtl">

- تانل DNS ذاتاً کندتر از اتصال مستقیمه (معمولاً 0.5-5 Mbps)
- MTU رو امتحان کنید: `DNSTT_MTU=512` (سازگاری بیشتر) یا `DNSTT_MTU=1452` (سرعت بیشتر)
- از DNS resolver نزدیک‌تر استفاده کنید

</div>

---

## نکات امنیتی

<div dir="rtl">

1. **کلید خصوصی رو هرگز به اشتراک نذارید** - فقط توی Worker و سرور باید باشه
2. **ترافیک end-to-end رمزنگاری شده** - نه Cloudflare و نه ISP محتوای تانل رو نمی‌بینن
3. **Worker خودتون رو استفاده کنید** - به Worker دیگران اعتماد نکنید
4. **DNS leak** - حتماً "Proxy DNS when using SOCKS v5" رو فعال کنید
5. **دامنه‌تون رو عوض نکنید** مگه اینکه سرور هم آپدیت بشه

</div>

---

## خلاصه سریع

```
1. دکمه "Deploy to Cloudflare" → Worker آماده
2. DNS رکوردها: A (tns→IP) + NS (t→tns)
3. سرور: go build → gen-key → iptables → run
4. کلید خصوصی → Worker Settings
5. کلاینت: go build → dnstt-client -doh → ssh -D
6. مرورگر: SOCKS5 127.0.0.1:1080
```

---

## لینک‌های مفید

- [dnstt Official](https://www.bamsoftware.com/software/dnstt/) - سایت رسمی dnstt
- [Cloudflare Workers](https://workers.cloudflare.com/) - سرویس Worker رایگان
- [Go Downloads](https://go.dev/dl/) - دانلود Go
- [DoH Resolvers](https://github.com/curl/curl/wiki/DNS-over-HTTPS) - لیست DNS Resolver های DoH

</div>
