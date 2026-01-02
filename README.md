<p align="center">
  <img
    src="https://beanman.net/yuri.png"
    alt="BeanPing Yuri Logo"
    width="440"
  />
</p>

<p align="center">
  A lightweight Node.js network monitoring dashboard with
  <strong>real-time updates</strong>,
  <strong>SQLite storage</strong>, and a
  <strong>modern web UI</strong>.
</p>

BeanPing continuously pings your nodes, stores results, and gives you a live
dashboard of latency, packet loss, and jitter. It also includes problem node
detection, database backup/restore, and more.

---

## 🆕 What’s New in v1.2.0

Version <strong>1.2.0</strong> introduces major improvements to networking,
automation, and webhooks, along with UI enhancements.

### 🌐 Networking & Core Improvements
- ✅ <strong>IPv6 tested and fully working</strong>
- 🔔 <strong>Fixed update notification system</strong>
- 💾 <strong>Automatic database backup scheduling</strong>

### ⚙️ Node Management
- ✏️ <strong>Edit node settings directly from the node view page</strong>

### 🔔 Webhooks Enhancements
- ⏱️ <strong>Time-stamped webhook events</strong>
- ✏️ <strong>Edit existing webhooks</strong>
- 🌍 <strong>Global and per-node webhook configuration</strong>
- ⏸️ <strong>Pause / resume webhooks</strong>

### 🌸 Yuri v2
- 🧿 <strong>New Yuri favicon</strong> (thanks to
  <a href="https://github.com/minoplhy">@minoplhy</a>)
- 🖼️ <strong>New Yuri logo</strong> (thanks to
  <a href="https://github.com/minoplhy">@minoplhy</a>)

---

## ✨ Features

- 📡 Monitors nodes by pinging them 10 times per minute
- ⏱️ Tracks <strong>latency</strong>, <strong>packet loss</strong>, and
  <strong>jitter</strong>
- ⚠️ Highlights problem nodes automatically (threshold detection)
- 📊 Dashboard + per-node stats + compare view
- 💾 Local SQLite database (easy backup/restore)
- 🔌 Real-time updates using WebSockets (Socket.IO)
- 🔒 Runs as a systemd service on Linux

---

## 🚀 Installation

### 1. Clone the repo into a safe directory
⚠️ <strong>Do not clone into <code>/root</code></strong> — the service user
cannot access it.

Recommended locations: <code>/srv/beanping</code>,
<code>/opt/beanping</code>, or
<code>/home/youruser/beanping</code>.

```bash
cd /srv
git clone https://github.com/beanman109/beanping.git
cd beanping
```

### 2. Run the installer (as root)

```bash
chmod +x install.sh
./install.sh
```

The installer will:
- Create a dedicated service user <code>beanping</code>
- Install dependencies (<code>node</code>, <code>sqlite3</code>,
  <code>traceroute</code>, <code>mtr</code>)
- Run <code>npm install --production</code>
- Create an empty <code>monitor.db</code> if needed
- Create + enable a systemd service (<code>beanping.service</code>)

---

## 🖥️ Usage

Once installed, BeanPing will run automatically as a background service.

- Access the dashboard:  
  👉 http://localhost:3000

- Manage the systemd service:

```bash
systemctl start beanping
systemctl stop beanping
systemctl restart beanping
systemctl status beanping
journalctl -u beanping -f
```

---

## 🔄 Updating

To pull updates from GitHub and restart:

```bash
cd /srv/beanping
git pull
npm install --production
systemctl restart beanping
```

---

## 🔧 Troubleshooting

- <strong>Service fails with <code>Permission denied</code></strong>  
  → Make sure the repo is <em>not</em> under <code>/root</code>; move it to
  <code>/srv/beanping</code> or <code>/opt/beanping</code>.

- <strong>Missing database error</strong>  
  → Create one (installer normally does this):
  ```bash
  touch /srv/beanping/monitor.db
  chown beanping:beanping /srv/beanping/monitor.db
  ```

- <strong>Cannot find module xxx</strong>  
  → Run <code>npm install --production</code> in the repo folder.

---