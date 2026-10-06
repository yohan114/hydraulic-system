# Hydraulic System: Production VPS Deployment & Multi-User Access Guide

This guide walks you through moving your Hydraulic Hose Repair & Smart Billing system from your local PC to a cloud Virtual Private Server (VPS) so your team, cashiers, technicians, and managers can securely access it from anywhere.

---

## 1. Architecture Overview for VPS

```
                     [ Internet / Users ]
                              │
                    HTTPS Port 443 (SSL/TLS)
                              │
                    ┌─────────▼─────────┐
                    │   Reverse Proxy   │ (Nginx or Caddy)
                    │  • SSL Encryption │
                    │  • Rate Limiting  │
                    │  • Security Header│
                    └─────────┬─────────┘
                              │
                     Internal Port 9999
                              │
                    ┌─────────▼─────────┐
                    │    Node.js / PM2  │ (Process Manager)
                    │  • Express API    │
                    │  • RBAC Auth Gate │
                    │  • Field Scrubber │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │    hydraulic.db   │ (SQLite with WAL mode)
                    │  + Automated Daily│
                    │    Backups (7-day)│
                    └───────────────────┘
```

---

## 2. Recommended VPS Hardware & OS

- **Operating System**: Ubuntu 22.04 LTS or Ubuntu 24.04 LTS (recommended)
- **CPU**: 1–2 vCPU (SQLite and Node.js are very lightweight and efficient)
- **RAM**: 2 GB RAM (minimum 1 GB)
- **Disk**: 25 GB+ SSD
- **Popular Providers**:
  - Hetzner Cloud (CX22 / CPX21 — ~€4–€7/month)
  - DigitalOcean Basic Droplet ($6–$12/month)
  - AWS Lightsail ($5–$10/month)
  - Linode / Akamai ($5–$12/month)

---

## 3. Step-by-Step VPS Setup

### Step 3.1: Point Your Domain to the VPS
In your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.):
1. Create an **A Record**:
   - **Host/Name**: `billing` (or `@` for root)
   - **Points to / Value**: `<Your_VPS_Public_IP>`
   - **TTL**: Auto / 300s
2. Wait 2–5 minutes for DNS propagation.

---

### Step 3.2: Transfer the Code & Reconciled Database to the VPS
On your local PC (PowerShell), run `scp` or `rsync` to upload the directory to your VPS:

```powershell
# From your local PC:
scp -r "D:\hy 1" root@<YOUR_VPS_IP>:/var/www/hydraulic-system
```

*(Ensure `hydraulic.db` and the `dashboard` folder are transferred).*

---

### Step 3.3: Run the Automated VPS Setup Script
Log in to your VPS via SSH:

```bash
ssh root@<YOUR_VPS_IP>
cd /var/www/hydraulic-system/dashboard/deploy
chmod +x setup-vps.sh
sudo ./setup-vps.sh
```

The script will automatically:
- Install Node.js 20 LTS and build tools.
- Install PM2 process manager.
- Configure the firewall (ports 22, 80, 443).
- Install production npm packages (`npm install --omit=dev`).
- Start the application with PM2 and configure auto-restart on server reboot.

---

### Step 3.4: Configure Environment & Secret Key
In `/var/www/hydraulic-system/dashboard`:

```bash
# Generate a strong 64-character secret
openssl rand -hex 32

# Create your .env file
nano .env
```

Paste your configuration:
```env
PORT=9999
NODE_ENV=production
TRUST_PROXY=1
BILLING_AUTH=on
BILLING_SECRET=PASTE_THE_64_CHAR_HEX_SECRET_HERE
```

Save (`Ctrl+O`, `Enter`) and exit (`Ctrl+X`).

Restart PM2 to apply:
```bash
pm2 restart hydraulic-system
```

---

### Step 3.5: Set Up Free HTTPS (SSL) with Let's Encrypt

#### Option A: Using Nginx + Certbot (Industry Standard)
```bash
# 1. Install Nginx and Certbot
apt-get install -y nginx certbot python3-certbot-nginx

# 2. Copy the pre-configured Nginx config
cp /var/www/hydraulic-system/dashboard/deploy/nginx.conf /etc/nginx/sites-available/hydraulic-system

# 3. Edit the domain name in the config
nano /etc/nginx/sites-available/hydraulic-system
# (Replace billing.yourshop.com with your actual domain)

# 4. Enable the site and test configuration
ln -s /etc/nginx/sites-available/hydraulic-system /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t

# 5. Issue free SSL certificate
certbot --nginx -d billing.yourshop.com

# 6. Reload Nginx
systemctl reload nginx
```

#### Option B: Using Caddy (Zero-Config Automatic HTTPS)
If you prefer not to manage Certbot renewals manually:
```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Copy Caddyfile
cp /var/www/hydraulic-system/dashboard/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile # (Set your domain)
systemctl reload caddy
```
Caddy automatically obtains and renews SSL certificates silently in the background.

---

## 4. User Roles & Privileges Structure

When multiple team members access the system, assign roles according to their job responsibilities:

| Feature / Action | Admin | Manager | Cashier | Viewer |
|---|:---:|:---:|:---:|:---:|
| **Create & Finalize Customer Invoices** | ✅ | ✅ | ✅ | ❌ |
| **Collect Cash / Bank Payments** | ✅ | ✅ | ✅ | ❌ |
| **View Stock Quantities** | ✅ | ✅ | ✅ | ✅ |
| **View Wholesale Item Costs & Margins** | ✅ | ✅ | ❌ *(Masked)* | ❌ *(Masked)* |
| **Approve Credit Refunds & Discounts** | ✅ | ✅ *(Dual Control)* | ❌ *(Request Only)* | ❌ |
| **Job Profit Analysis Reports** | ✅ | ✅ | ❌ | ❌ |
| **Enter Supplier Bills & Orders** | ✅ | ✅ | ❌ | ❌ |
| **General Ledger & Journal Entries** | ✅ | ❌ | ❌ | ❌ |
| **Close / Reopen Accounting Periods** | ✅ | ❌ | ❌ | ❌ |
| **User & Staff Account Management** | ✅ | ❌ | ❌ | ❌ |
| **System Database Backups** | ✅ | ❌ | ❌ | ❌ |

---

## 5. Staff Management Best Practices

1. **Create Individual Logins for Each Person**:
   - Never share one login among multiple cashiers or managers.
   - Every invoice, payment, revision, and audit log stamps the exact `username` of who performed the action.
2. **Deactivating Staff Who Leave**:
   - In **Users & Roles**, click **Disable** instead of deleting the user.
   - This instantly blocks them from logging in, while preserving all historical bills and audit trails they created.
3. **Revoking Active Sessions on Lost/Stolen Devices**:
   - If an employee loses their phone or laptop, click **Revoke** next to their name.
   - Their session version is bumped (`AuthVersion`), immediately terminating their access on all browsers.

---

## 6. Daily Off-Site Automated Backups

The system already creates local daily snapshots in `/var/www/hydraulic-system/backups/`. To protect against VPS hardware loss, schedule an off-site backup via cron:

Add a cron job (`crontab -e`):
```bash
# Take a verified snapshot every day at 11:30 PM
30 23 * * * cd /var/www/hydraulic-system/dashboard && /usr/bin/node backup-cli.js --label daily >> /var/log/hydraulic-backup.log 2>&1
```

*(Optional: Use `rclone` or `aws-cli` to sync `/var/www/hydraulic-system/backups/` to Google Drive, Dropbox, or Cloudflare R2).*

---

## 7. Useful Server Management Commands

```bash
# Check running status
pm2 status

# View live system logs
pm2 logs hydraulic-system

# Restart the application
pm2 restart hydraulic-system

# Run a manual verified database backup
cd /var/www/hydraulic-system/dashboard && npm run backup

# Check database integrity via CLI
node -e "const db = require('./db')._db; console.log(db.pragma('integrity_check'));"
```
