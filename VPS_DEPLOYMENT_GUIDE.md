# Hydraulic System: Production VPS Deployment & Multi-User Access Guide

This guide walks you through moving your Hydraulic Hose Repair & Smart Billing system from your local PC to a cloud Virtual Private Server (VPS) so your team, cashiers, technicians, and managers can securely access it from anywhere with automated security, backups, and role permissions.

---

## 1. Production Architecture Overview

```
                     [ Internet / Users ]
                              │
                    Cloudflare Proxy (DDoS & WAF)
                              │
                    HTTPS Port 443 (SSL/TLS)
                              │
                    ┌─────────▼─────────┐
                    │   Linux UFW &     │
                    │    Fail2ban       │ (Bans attackers on 5 failed logins)
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Nginx Proxy     │ (Rate Limiting: 10r/m on Login & PDF)
                    │  • Cloudflare IP  │ (Restores real client IP)
                    │  • Security Header│ (HSTS, nosniff, SAMEORIGIN)
                    └─────────┬─────────┘
                              │
                     Internal Port 9999
                              │
                    ┌─────────▼─────────┐
                    │   Node.js / PM2   │ (Supervised single instance)
                    │  • Express API    │
                    │  • RBAC Auth Gate │
                    │  • Field Scrubber │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │   hydraulic.db    │ (SQLite with WAL mode)
                    │  + Automated Daily│ (Scheduled verified snapshots)
                    │    Backups (7-day)│
                    └───────────────────┘
```

---

## 2. Recommended VPS Specifications

- **Operating System**: Ubuntu 22.04 LTS or Ubuntu 24.04 LTS (recommended) / Debian 11 or 12
- **CPU**: 1–2 vCPU (SQLite and Node.js are very lightweight and efficient)
- **RAM**: 2 GB RAM (minimum 1 GB)
- **Disk**: 25 GB+ SSD
- **Popular Providers**:
  - Hetzner Cloud (CX22 / CPX21 — ~€4–€7/month)
  - DigitalOcean Basic Droplet ($6–$12/month)
  - AWS Lightsail ($5–$10/month)
  - Linode / Akamai ($5–$12/month)

---

## 3. Fast Automated VPS Deployment (One Command)

### Step 3.1: Point Your Domain to the VPS
In your DNS provider (Cloudflare, GoDaddy, Namecheap):
1. Create an **A Record**:
   - **Name**: `billing` (or `@` for root domain)
   - **IPv4 Address**: `<YOUR_VPS_PUBLIC_IP>`
   - **Proxy Status**: DNS only (Grey Cloud) during initial SSL issuance, or Proxied (Orange Cloud) if using Cloudflare Origin SSL.
2. Wait 2–5 minutes for DNS propagation.

---

### Step 3.2: Transfer Project Files to the VPS
From your local computer (PowerShell):

```powershell
# Upload the project directory to the VPS:
scp -r "D:\hy 1" root@<YOUR_VPS_IP>:/var/www/hydraulic-system
```

*(Ensure `hydraulic.db` and the `dashboard` folder are transferred).*

---

### Step 3.3: Run the Hardened Automated Setup Script
Log in to your VPS via SSH and run the setup script:

```bash
ssh root@<YOUR_VPS_IP>
cd /var/www/hydraulic-system/dashboard/deploy
chmod +x setup-vps.sh restore-vps.sh backup-cron.sh

# Run with your domain and admin email:
sudo ./setup-vps.sh --domain billing.yourshop.com --email admin@yourshop.com
```

*(If you don't have a domain name yet, simply run `sudo ./setup-vps.sh` to configure the system directly for your VPS IP).*

#### What the setup script automatically configures:
1. **Security Packages**: Installs `ufw`, `fail2ban`, `nginx`, `certbot`, `sqlite3`, `cron`, `logrotate`.
2. **Headless Chromium Libraries**: Pre-installs all Linux shared libraries required by Puppeteer so invoice and job profit PDF exports run smoothly.
3. **Node.js 20 LTS & PM2**: Installs the LTS runtime and PM2 supervisor with log rotation (`pm2-logrotate`).
4. **Hardened Firewall (UFW)**: Blocks all inbound ports except SSH (rate-limited), HTTP (80), and HTTPS (443).
5. **Fail2ban Anti-Intrusion**: Activates custom fail2ban filters that automatically ban IP addresses for 24 hours if they trigger 5 failed login attempts or aggressively scan endpoints.
6. **Production Secrets**: Auto-generates a 256-bit cryptographic signing key (`BILLING_SECRET`) in `.env` and locks file permissions to `chmod 600`.
7. **Database Security**: Hardens file permissions on `hydraulic.db` to `chmod 640`.
8. **Nginx Reverse Proxy**:
   - Enables rate limiting on `/api/auth/login` (10 req/min).
   - Enables rate limiting on PDF exports (10 req/min).
   - Configures Cloudflare Real-IP extraction (`CF-Connecting-IP`).
   - Injects security headers (HSTS, nosniff, SAMEORIGIN).
9. **Automatic SSL**: Obtains and configures a free Let's Encrypt SSL certificate via Certbot.
10. **Automated Daily Backups**: Installs a daily cron job at 23:30 to run `backup-cli.js` with automated integrity checks.
11. **PM2 Autostart**: Configures systemd startup so the service resumes automatically after server reboots.

---

## 4. User Roles & Privileges Structure

When multiple team members access the system, assign roles according to their job responsibilities:

| Feature / Action | Admin | Manager | Cashier | Viewer |
|---|:---:|:---:|:---:|:---:|
| **Create & Finalize Customer Invoices** | ✅ | ✅ | ✅ | ❌ |
| **Collect Cash / Bank Payments** | ✅ | ✅ | ✅ | ❌ |
| **Convert Workshop Jobs to Invoices** | ✅ | ✅ | ✅ | ❌ |
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

## 6. Backup & Disaster Recovery Operations

### Automatic Daily Backups
The server automatically takes a verified SQLite snapshot every night at 11:30 PM:
- Stored in `/var/www/hydraulic-system/dashboard/backups/`.
- Verified with `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.
- Logs written to `/var/log/hydraulic-backup.log`.

### Manual On-Demand Backup
To take an immediate backup before major operations or updates:
```bash
sudo /usr/local/bin/hydraulic-backup.sh
# or via npm in the dashboard directory:
cd /var/www/hydraulic-system/dashboard && npm run backup
```

### Emergency 1-Click Database Restore
If a server crash or human error requires restoring a previous database snapshot:
```bash
cd /var/www/hydraulic-system/dashboard/deploy
sudo ./restore-vps.sh
```
The restore tool will:
1. List all available verified snapshots with file sizes and dates.
2. Prompt you to choose which snapshot to restore.
3. Stop PM2 safely to release file locks.
4. Create a pre-restore backup of the current database.
5. Restore the snapshot and verify SQLite integrity.
6. Restart the application with zero data corruption.

---

## 7. Useful Server Management Commands

```bash
# Check application status
pm2 status

# View live application logs
pm2 logs hydraulic-system

# Restart the application
pm2 restart hydraulic-system

# Check active Fail2ban intrusion jails & banned IPs
sudo fail2ban-client status
sudo fail2ban-client status hydraulic-login
sudo fail2ban-client status sshd

# Unban an accidental locked-out IP
sudo fail2ban-client set hydraulic-login unbanip <IP_ADDRESS>

# Check firewall rules
sudo ufw status verbose

# Test Nginx configuration & reload
sudo nginx -t
sudo systemctl reload nginx

# Check database integrity via Node CLI
node -e "const db = require('./db')._db; console.log(db.pragma('integrity_check'));"
```

---

## 8. Enabling Cloudflare DDoS & WAF Protection (Optional but Recommended)

For maximum security against cyberattacks:
1. Route your domain DNS through Cloudflare and turn **Proxy ON (Orange Cloud)**.
2. In Cloudflare Dashboard -> **SSL/TLS**: Set mode to **Full (Strict)**.
3. In Cloudflare Dashboard -> **Security** -> **WAF**:
   - Create a rate-limiting rule for `/api/auth/login` (block if > 5 requests/minute).
4. Because `setup-vps.sh` installs `cloudflare-ips.conf`, Nginx will automatically resolve and log real visitor IP addresses instead of Cloudflare proxy IPs.
