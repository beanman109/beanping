# 🌐 BeanPing

A lightweight Node.js network monitoring dashboard with **real-time updates**,  
**SQLite storage**, and a **modern web UI**.

BeanPing continuously pings your nodes, stores results, and gives you a live dashboard of latency, packet loss, and jitter. It also includes per-node traceroute/MTR, problem node detection, database backup/restore, and more.

---

## ✨ Features

- 📡 Monitors nodes by pinging them 10 times per minute  
- ⏱️ Tracks **latency**, **packet loss**, and **jitter**  
- ⚠️ Highlights problem nodes automatically (threshold detection)  
- 🌍 Visual traceroute and MTR support  
- 📊 Dashboard + per-node stats + compare view  
- 💾 Local SQLite database (easy backup/restore)  
- 🔌 Real-time updates using WebSockets (Socket.IO)  
- 🔒 Runs as a systemd service on Linux  

---

## 🚀 Installation

### 1. Clone the repo into a safe directory  
⚠️ **Do not clone into `/root`** — the service user cannot access it.  

Recommended locations: `/srv/beanping`, `/opt/beanping`, or `/home/youruser/beanping`.

```bash
# Example: install into /srv
cd /srv
git clone https://github.com/beanman109/beanping.git
cd beanping
```

### 2. Run the installer (as root)

```bash
# Make script executable
chmod +x install.sh

# Run install
./install.sh
```

The installer will:  
- Create a dedicated service user `beanping`  
- Install dependencies (`node`, `sqlite3`, `traceroute`, `mtr`)  
- Run `npm install --production`  
- Create an empty `monitor.db` if needed  
- Create + enable a systemd service (`beanping.service`)  

---

## 🖥️ Usage

Once installed, BeanPing will run automatically as a background service.

- Access the dashboard:  
  👉 [http://localhost:3000](http://localhost:3000)

- Manage the systemd service:

```bash
# Start the service
systemctl start beanping

# Stop the service
systemctl stop beanping

# Restart after changes
systemctl restart beanping

# Check status
systemctl status beanping

# Follow logs
journalctl -u beanping -f
```

---

## 🔄 Updating

To pull updates from GitHub and restart:

```bash
cd /srv/beanping   # or wherever you cloned
git pull
npm install --production
systemctl restart beanping
```

---

## 🔧 Troubleshooting

- **Service fails with `Permission denied`** → Make sure repo is *not* under `/root`; move it to `/srv/beanping` or `/opt/beanping`.  
- **Missing database error** → Create one (installer normally does this):  
  ```bash
  touch /srv/beanping/monitor.db
  chown beanping:beanping /srv/beanping/monitor.db
  ```
- **Cannot find module xxx** → Run `npm install --production` in the repo folder.  

---
