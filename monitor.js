// monitor.js (Optimized for Large Datasets & Discord Fixed)
const express = require("express");
const bodyParser = require("body-parser");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const path = require("path");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const { exec, spawn } = require("child_process");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let db = new Database("monitor.db");

// ============================================
// IN-MEMORY CACHE
// ============================================
// Structure: { nodeId: { latency: 20, packetLoss1h: 0.1, jitter: 2.5, avgJitter1h: 2.0 } }
// This prevents N+1 DB queries on dashboard load
let nodeStatsCache = {};

// Setup multer for file uploads
const upload = multer({ dest: "temp-uploads/" });

// Create temp-uploads directory if it doesn't exist
if (!fs.existsSync("temp-uploads")) {
  fs.mkdirSync("temp-uploads");
}

// Setup DB
db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  status TEXT DEFAULT 'offline',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ping_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  latency REAL,
  packet_loss REAL,
  jitter REAL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_node_timestamp
ON ping_results(node_id, timestamp);

-- Index for faster time-range queries (CRITICAL for large datasets)
CREATE INDEX IF NOT EXISTS idx_timestamp 
ON ping_results(timestamp);

-- Global settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Webhook tables
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  notify_online INTEGER DEFAULT 1,
  notify_offline INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS node_webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  webhook_id INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  notify_online INTEGER DEFAULT 1,
  notify_offline INTEGER DEFAULT 1,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE,
  UNIQUE(node_id, webhook_id)
);
`);

// Add grace period columns to nodes if they don't exist
try { db.exec(`ALTER TABLE nodes ADD COLUMN offline_grace_period INTEGER DEFAULT NULL`); } catch (e) {}
try { db.exec(`ALTER TABLE nodes ADD COLUMN online_grace_period INTEGER DEFAULT NULL`); } catch (e) {}

// Initialize default settings if not present
const defaultSettings = {
  offline_grace_period: "3", // Consecutive failures before marking offline
  online_grace_period: "2", // Consecutive successes before marking online
  packet_loss_threshold: "100", // Packet loss % to consider a ping "failed"
};

for (const [key, value] of Object.entries(defaultSettings)) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!existing) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}

// ============================================
// CACHE WARMUP FUNCTION
// ============================================
function warmupCache() {
  console.log("🔥 Warming up stats cache (this may take a moment for large DBs)...");
  const nodes = db.prepare("SELECT id FROM nodes").all();
  
  // Use a transaction for read consistency if needed, though mostly relevant for writes
  const getLatest = db.prepare("SELECT latency, packet_loss, jitter FROM ping_results WHERE node_id = ? ORDER BY timestamp DESC LIMIT 1");
  const getAvgs = db.prepare(`
    SELECT AVG(jitter) as avgJitter, AVG(packet_loss) as avgLoss 
    FROM ping_results 
    WHERE node_id = ? AND datetime(replace(replace(timestamp, 'T', ' '), 'Z', '')) > datetime('now', '-1 hour')
  `);

  nodes.forEach(node => {
    const last = getLatest.get(node.id);
    const avgs = getAvgs.get(node.id);

    nodeStatsCache[node.id] = {
      latency: last?.latency || null,
      jitter: last?.jitter || 0,
      packetLoss1h: avgs?.avgLoss || (last?.packet_loss || 0), // Fallback to last known if no avg
      avgJitter1h: avgs?.avgJitter || 0
    };
  });
  console.log(`✅ Cache warmed for ${nodes.length} nodes.`);
}

// Run cache warmup immediately on startup
warmupCache();

// ============================================
// SETTINGS HELPER FUNCTIONS
// ============================================

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultSettings[key];
}

function getSettingInt(key) {
  return parseInt(getSetting(key), 10);
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const settings = {};
  rows.forEach((row) => {
    settings[row.key] = row.value;
  });
  return settings;
}

// ============================================
// GRACE PERIOD LOGIC
// ============================================

// Get effective grace periods for a node (node-specific or global fallback)
function getNodeGracePeriods(nodeId) {
  const node = db
    .prepare("SELECT offline_grace_period, online_grace_period FROM nodes WHERE id = ?")
    .get(nodeId);

  const globalOffline = getSettingInt("offline_grace_period");
  const globalOnline = getSettingInt("online_grace_period");

  return {
    offline: node?.offline_grace_period ?? globalOffline,
    online: node?.online_grace_period ?? globalOnline,
  };
}

// Count consecutive failed/successful pings for a node (most recent first)
function getConsecutivePingStatus(nodeId, limit = 10) {
  const threshold = getSettingInt("packet_loss_threshold");

  const recentPings = db
    .prepare(
      `SELECT packet_loss FROM ping_results 
       WHERE node_id = ? 
       ORDER BY timestamp DESC 
       LIMIT ?`
    )
    .all(nodeId, limit);

  if (recentPings.length === 0) {
    return { consecutiveFailures: 0, consecutiveSuccesses: 0 };
  }

  let consecutiveFailures = 0;
  let consecutiveSuccesses = 0;

  // Count consecutive failures from most recent
  for (const ping of recentPings) {
    if (ping.packet_loss >= threshold) {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  // Count consecutive successes from most recent
  for (const ping of recentPings) {
    if (ping.packet_loss < threshold) {
      consecutiveSuccesses++;
    } else {
      break;
    }
  }

  return { consecutiveFailures, consecutiveSuccesses };
}

// Determine if status should change based on grace periods
function evaluateNodeStatus(nodeId, currentDbStatus) {
  const gracePeriods = getNodeGracePeriods(nodeId);
  const { consecutiveFailures, consecutiveSuccesses } = getConsecutivePingStatus(
    nodeId,
    Math.max(gracePeriods.offline, gracePeriods.online) + 1
  );

  let newStatus = currentDbStatus;
  let shouldTriggerWebhook = false;

  if (currentDbStatus === "online" && consecutiveFailures >= gracePeriods.offline) {
    // Node was online, now has enough consecutive failures -> go offline
    newStatus = "offline";
    shouldTriggerWebhook = true;
  } else if (
    currentDbStatus === "offline" &&
    consecutiveSuccesses >= gracePeriods.online
  ) {
    // Node was offline, now has enough consecutive successes -> go online
    newStatus = "online";
    shouldTriggerWebhook = true;
  }

  return { newStatus, shouldTriggerWebhook, consecutiveFailures, consecutiveSuccesses };
}

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "views")));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ============================================
// WEBHOOK HELPER FUNCTIONS
// ============================================

async function sendWebhook(url, payload) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === "https:";
      const lib = isHttps ? https : http;

      const data = JSON.stringify(payload);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "User-Agent": "BeanPing-Monitor/1.0",
        },
        timeout: 10000,
      };

      const req = lib.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, statusCode: res.statusCode });
          } else {
            resolve({ success: false, statusCode: res.statusCode, body });
          }
        });
      });

      req.on("error", (err) => {
        console.error(`Webhook error for ${url}:`, err.message);
        resolve({ success: false, error: err.message });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ success: false, error: "Request timeout" });
      });

      req.write(data);
      req.end();
    } catch (err) {
      console.error(`Webhook error for ${url}:`, err.message);
      resolve({ success: false, error: err.message });
    }
  });
}

async function triggerWebhookAlerts(node, oldStatus, newStatus, details = {}) {
  if (oldStatus === newStatus) return;

  const isGoingOnline = newStatus === "online";
  const eventType = isGoingOnline ? "node_online" : "node_offline";
  const eventField = isGoingOnline ? "notify_online" : "notify_offline";

  const gracePeriods = getNodeGracePeriods(node.id);

  const messageText = isGoingOnline
      ? `🟢 Node "${node.name}" (${node.ip}) is now ONLINE (after ${details.consecutiveSuccesses} successful pings)`
      : `🔴 Node "${node.name}" (${node.ip}) is now OFFLINE (after ${details.consecutiveFailures} failed pings)`;

  const payload = {
    content: messageText, // Discord
    text: messageText,    // Slack/Teams
    message: messageText, // Generic
    event: eventType,
    timestamp: new Date().toISOString(),
    node: {
      id: node.id,
      name: node.name,
      ip: node.ip,
      previousStatus: oldStatus,
      currentStatus: newStatus,
    },
    gracePeriod: isGoingOnline ? gracePeriods.online : gracePeriods.offline,
    consecutiveCount: isGoingOnline
      ? details.consecutiveSuccesses
      : details.consecutiveFailures,
  };

  // Get global webhooks
  const globalWebhooks = db
    .prepare(`SELECT * FROM webhooks WHERE enabled = 1 AND ${eventField} = 1`)
    .all();

  // Get node-specific overrides
  const nodeWebhookOverrides = db
    .prepare(
      `SELECT nw.*, w.url, w.name as webhook_name 
       FROM node_webhooks nw
       JOIN webhooks w ON nw.webhook_id = w.id
       WHERE nw.node_id = ?`
    )
    .all(node.id);

  const overrideWebhookIds = new Set(nodeWebhookOverrides.map((o) => o.webhook_id));

  // Send to global webhooks (unless overridden)
  for (const webhook of globalWebhooks) {
    if (overrideWebhookIds.has(webhook.id)) continue;

    console.log(`📤 Sending ${eventType} webhook to: ${webhook.name}`);
    const result = await sendWebhook(webhook.url, payload);
    if (!result.success) {
      console.error(`❌ Webhook failed for ${webhook.name}:`, result.error || result.body);
    } else {
      console.log(`✅ Webhook sent successfully to: ${webhook.name}`);
    }
  }

  // Send to node-specific overrides
  for (const override of nodeWebhookOverrides) {
    if (!override.enabled) continue;
    if (isGoingOnline && !override.notify_online) continue;
    if (!isGoingOnline && !override.notify_offline) continue;

    console.log(`📤 Sending ${eventType} node-specific webhook to: ${override.webhook_name}`);
    const result = await sendWebhook(override.url, payload);
    if (!result.success) {
      console.error(
        `❌ Webhook failed for ${override.webhook_name}:`,
        result.error || result.body
      );
    } else {
      console.log(`✅ Node webhook sent successfully to: ${override.webhook_name}`);
    }
  }
}

// ============================================
// PING HELPER FUNCTIONS
// ============================================

function pingNode(ip, count = 10) {
  return new Promise((resolve, reject) => {
    exec(`ping -c ${count} -i 0.2 ${ip}`, (error, stdout, stderr) => {
      if (error && !stdout) return reject(stderr);

      const match = stdout.match(/(\d+) packets transmitted, (\d+) received/);
      const rttMatch = stdout.match(/rtt min\/avg\/max\/mdev = (.+)/);

      if (match) {
        const sent = parseInt(match[1], 10);
        const received = parseInt(match[2], 10);
        const packetLoss = ((sent - received) / sent) * 100;

        let avgLatency = null;
        let jitter = null;

        if (rttMatch) {
          const parts = rttMatch[1].split("/");
          avgLatency = parseFloat(parts[1]);
          jitter = parseFloat(parts[3]);
        }

        resolve({ latency: avgLatency, packetLoss, jitter });
      } else {
        resolve({ latency: null, packetLoss: 100, jitter: null });
      }
    });
  });
}

function getProblemNodes() {
  // This query remains somewhat expensive but is now handled by the cron cycle
  // and emitted via socket, rather than requested on page load by default.
  // Note: We are relying on the DB here because we need aggregation that is slightly more complex
  // than simple k/v cache, but we could cache this too if needed.
  return db
    .prepare(
      `SELECT n.id, n.name, n.ip,
              SUM(CASE WHEN p.packet_loss = 10 THEN 1 ELSE 0 END) as loss10Count,
              SUM(CASE WHEN p.packet_loss > 10 THEN 1 ELSE 0 END) as highLossCount,
              SUM(CASE WHEN p.jitter > 50 THEN 1 ELSE 0 END) as highJitterCount
       FROM nodes n
       JOIN ping_results p ON n.id = p.node_id
       WHERE datetime(replace(replace(p.timestamp, 'T', ' '), 'Z', '')) > datetime('now', '-1 hour')
       GROUP BY n.id
       HAVING loss10Count >= 4 OR highLossCount >= 4 OR highJitterCount >= 4`
    )
    .all();
}

// ============================================
// SETTINGS API ENDPOINTS
// ============================================

// API: Get all settings
app.get("/api/settings", (req, res) => {
  res.json(getAllSettings());
});

// API: Update settings
app.put("/api/settings", (req, res) => {
  const { offline_grace_period, online_grace_period, packet_loss_threshold } = req.body;

  if (offline_grace_period !== undefined) {
    const val = parseInt(offline_grace_period, 10);
    if (isNaN(val) || val < 1 || val > 60) {
      return res
        .status(400)
        .json({ error: "offline_grace_period must be between 1 and 60" });
    }
    setSetting("offline_grace_period", val);
  }

  if (online_grace_period !== undefined) {
    const val = parseInt(online_grace_period, 10);
    if (isNaN(val) || val < 1 || val > 60) {
      return res
        .status(400)
        .json({ error: "online_grace_period must be between 1 and 60" });
    }
    setSetting("online_grace_period", val);
  }

  if (packet_loss_threshold !== undefined) {
    const val = parseInt(packet_loss_threshold, 10);
    if (isNaN(val) || val < 1 || val > 100) {
      return res
        .status(400)
        .json({ error: "packet_loss_threshold must be between 1 and 100" });
    }
    setSetting("packet_loss_threshold", val);
  }

  io.emit("settingsUpdated", getAllSettings());
  res.json(getAllSettings());
});

// ============================================
// WEBHOOK API ENDPOINTS
// ============================================

app.get("/api/webhooks", (req, res) => {
  const webhooks = db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all();
  res.json(webhooks);
});

app.get("/api/webhooks/:id", (req, res) => {
  const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(req.params.id);
  if (!webhook) return res.status(404).json({ error: "Webhook not found" });
  res.json(webhook);
});

app.post("/api/webhooks", (req, res) => {
  const { name, url, enabled = true, notify_online = true, notify_offline = true } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: "Name and URL are required" });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  const stmt = db.prepare(
    `INSERT INTO webhooks (name, url, enabled, notify_online, notify_offline) 
     VALUES (?, ?, ?, ?, ?)`
  );
  const result = stmt.run(
    name,
    url,
    enabled ? 1 : 0,
    notify_online ? 1 : 0,
    notify_offline ? 1 : 0
  );

  const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(result.lastInsertRowid);
  io.emit("webhookAdded", webhook);
  res.json(webhook);
});

app.put("/api/webhooks/:id", (req, res) => {
  const { name, url, enabled, notify_online, notify_offline } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: "Name and URL are required" });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  db.prepare(
    `UPDATE webhooks 
     SET name = ?, url = ?, enabled = ?, notify_online = ?, notify_offline = ?
     WHERE id = ?`
  ).run(
    name,
    url,
    enabled ? 1 : 0,
    notify_online ? 1 : 0,
    notify_offline ? 1 : 0,
    req.params.id
  );

  const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(req.params.id);
  io.emit("webhookUpdated", webhook);
  res.json(webhook);
});

app.delete("/api/webhooks/:id", (req, res) => {
  db.prepare("DELETE FROM node_webhooks WHERE webhook_id = ?").run(req.params.id);
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(req.params.id);
  io.emit("webhookDeleted", { id: parseInt(req.params.id) });
  res.json({ success: true });
});

app.post("/api/webhooks/:id/test", async (req, res) => {
  const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(req.params.id);
  if (!webhook) return res.status(404).json({ error: "Webhook not found" });

  const messageText = "🧪 This is a test webhook from BeanPing Monitor";

  const testPayload = {
    content: messageText, 
    text: messageText,    
    message: messageText, 
    event: "test",
    timestamp: new Date().toISOString(),
    node: {
      id: 0,
      name: "Test Node",
      ip: "0.0.0.0",
      previousStatus: "offline",
      currentStatus: "online",
    },
    gracePeriod: getSettingInt("online_grace_period"),
    consecutiveCount: getSettingInt("online_grace_period"),
  };

  const result = await sendWebhook(webhook.url, testPayload);

  if (result.success) {
    res.json({ success: true, message: "Test webhook sent successfully" });
  } else {
    let errorMsg = result.body;
    try {
        const jsonError = JSON.parse(result.body);
        errorMsg = JSON.stringify(jsonError);
    } catch (e) {}
    
    res.status(400).json({
      success: false,
      message: "Webhook test failed",
      error: result.error || errorMsg,
    });
  }
});

// ============================================
// NODE-SPECIFIC WEBHOOK & GRACE PERIOD API
// ============================================

app.get("/api/nodes/:id/webhooks", (req, res) => {
  const nodeId = req.params.id;

  const webhooks = db
    .prepare(
      `SELECT 
         w.*,
         nw.id as override_id,
         nw.enabled as override_enabled,
         nw.notify_online as override_notify_online,
         nw.notify_offline as override_notify_offline,
         CASE WHEN nw.id IS NOT NULL THEN 1 ELSE 0 END as has_override
       FROM webhooks w
       LEFT JOIN node_webhooks nw ON w.id = nw.webhook_id AND nw.node_id = ?
       ORDER BY w.name`
    )
    .all(nodeId);

  res.json(webhooks);
});

app.post("/api/nodes/:nodeId/webhooks/:webhookId", (req, res) => {
  const { nodeId, webhookId } = req.params;
  const { enabled = true, notify_online = true, notify_offline = true } = req.body;

  const existing = db
    .prepare("SELECT id FROM node_webhooks WHERE node_id = ? AND webhook_id = ?")
    .get(nodeId, webhookId);

  if (existing) {
    db.prepare(
      `UPDATE node_webhooks 
       SET enabled = ?, notify_online = ?, notify_offline = ?
       WHERE node_id = ? AND webhook_id = ?`
    ).run(enabled ? 1 : 0, notify_online ? 1 : 0, notify_offline ? 1 : 0, nodeId, webhookId);
  } else {
    db.prepare(
      `INSERT INTO node_webhooks (node_id, webhook_id, enabled, notify_online, notify_offline)
       VALUES (?, ?, ?, ?, ?)`
    ).run(nodeId, webhookId, enabled ? 1 : 0, notify_online ? 1 : 0, notify_offline ? 1 : 0);
  }

  res.json({ success: true });
});

app.delete("/api/nodes/:nodeId/webhooks/:webhookId", (req, res) => {
  const { nodeId, webhookId } = req.params;
  db.prepare("DELETE FROM node_webhooks WHERE node_id = ? AND webhook_id = ?").run(
    nodeId,
    webhookId
  );
  res.json({ success: true });
});

// API: Get node grace period settings
app.get("/api/nodes/:id/grace-periods", (req, res) => {
  const nodeId = req.params.id;
  const node = db
    .prepare("SELECT offline_grace_period, online_grace_period FROM nodes WHERE id = ?")
    .get(nodeId);

  if (!node) return res.status(404).json({ error: "Node not found" });

  const globalSettings = getAllSettings();

  res.json({
    node: {
      offline_grace_period: node.offline_grace_period,
      online_grace_period: node.online_grace_period,
    },
    effective: getNodeGracePeriods(nodeId),
    global: {
      offline_grace_period: parseInt(globalSettings.offline_grace_period, 10),
      online_grace_period: parseInt(globalSettings.online_grace_period, 10),
    },
  });
});

// API: Update node grace period settings
app.put("/api/nodes/:id/grace-periods", (req, res) => {
  const nodeId = req.params.id;
  const { offline_grace_period, online_grace_period } = req.body;

  // Validate - null means "use global"
  const offlineVal =
    offline_grace_period === null || offline_grace_period === ""
      ? null
      : parseInt(offline_grace_period, 10);
  const onlineVal =
    online_grace_period === null || online_grace_period === ""
      ? null
      : parseInt(online_grace_period, 10);

  if (offlineVal !== null && (isNaN(offlineVal) || offlineVal < 1 || offlineVal > 60)) {
    return res
      .status(400)
      .json({ error: "offline_grace_period must be between 1 and 60, or null" });
  }

  if (onlineVal !== null && (isNaN(onlineVal) || onlineVal < 1 || onlineVal > 60)) {
    return res
      .status(400)
      .json({ error: "online_grace_period must be between 1 and 60, or null" });
  }

  db.prepare(
    "UPDATE nodes SET offline_grace_period = ?, online_grace_period = ? WHERE id = ?"
  ).run(offlineVal, onlineVal, nodeId);

  res.json({
    success: true,
    effective: getNodeGracePeriods(nodeId),
  });
});

// ============================================
// EXISTING API ENDPOINTS
// ============================================

app.get("/api/backup", (req, res) => {
  const dbPath = path.join(__dirname, "monitor.db");

  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ error: "Database file not found" });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `beanping-backup-${timestamp}.db`;

  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/octet-stream");

  const fileStream = fs.createReadStream(dbPath);
  fileStream.pipe(res);
});

app.post("/api/restore", upload.single("backup"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No backup file provided" });
  }

  try {
    const uploadedPath = req.file.path;
    const dbPath = path.join(__dirname, "monitor.db");

    let testDb;
    try {
      testDb = new Database(uploadedPath);
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all();
      const tableNames = tables.map((t) => t.name);

      if (!tableNames.includes("nodes") || !tableNames.includes("ping_results")) {
        throw new Error("Invalid database structure");
      }
      testDb.close();
    } catch {
      fs.unlinkSync(uploadedPath);
      return res.status(400).json({ error: "Invalid database file" });
    }

    const backupPath = `${dbPath}.backup-${Date.now()}`;
    fs.copyFileSync(dbPath, backupPath);

    db.close();
    fs.copyFileSync(uploadedPath, dbPath);
    fs.unlinkSync(uploadedPath);

    db = new Database("monitor.db");

    res.json({ success: true, message: "Database restored successfully" });

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    console.error("Restore error:", error);
    res.status(500).json({ error: "Failed to restore database: " + error.message });
  }
});

app.post("/api/nodes", (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: "Invalid input" });
  const stmt = db.prepare("INSERT INTO nodes (name, ip) VALUES (?, ?)");
  const result = stmt.run(name, ip);

  // Initialize cache for new node
  nodeStatsCache[result.lastInsertRowid] = { latency: null, jitter: 0, packetLoss1h: 0, avgJitter1h: 0 };

  io.emit("nodeAdded", { id: result.lastInsertRowid, name, ip });
  res.json({ id: result.lastInsertRowid, name, ip });
});

app.put("/api/nodes/:id", (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: "Invalid input" });
  db.prepare("UPDATE nodes SET name = ?, ip = ? WHERE id = ?").run(name, ip, req.params.id);
  io.emit("nodeUpdated", { id: req.params.id, name, ip });
  res.json({ success: true });
});

app.delete("/api/nodes/:id", (req, res) => {
  const nodeId = parseInt(req.params.id);
  db.prepare("DELETE FROM node_webhooks WHERE node_id = ?").run(nodeId);
  db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  
  // Clean from cache
  delete nodeStatsCache[nodeId];

  io.emit("nodeRemoved", { id: req.params.id });
  res.json({ success: true });
});

app.get("/api/nodes/:id/stats", (req, res) => {
  const { id } = req.params;
  const range = req.query.range || "1 HOUR";
  const results = db
    .prepare(
      `SELECT latency, packet_loss, jitter, timestamp 
       FROM ping_results 
       WHERE node_id = ? AND datetime(replace(replace(timestamp, 'T', ' '), 'Z', '')) > datetime('now', '-' || ?)
       ORDER BY timestamp ASC`
    )
    .all(id, range);
  res.json(results);
});

app.get("/api/nodes/:id/mtr", (req, res) => {
  const { id } = req.params;
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  const cmd = "/usr/bin/mtr";
  const args = ["--report-wide", "--report-cycles", "10", node.ip];

  const child = spawn(cmd, args);

  let output = "";
  child.stdout.on("data", (data) => (output += data.toString()));
  let errorOutput = "";
  child.stderr.on("data", (data) => (errorOutput += data.toString()));

  child.on("close", (code) => {
    if (code !== 0) {
      console.error("MTR failed:", errorOutput);
      return res.status(500).json({ error: "MTR failed", details: errorOutput });
    }
    res.json({ output });
  });
});

app.get("/api/nodes/:id/traceroute", (req, res) => {
  const { id } = req.params;
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  const cmd = `traceroute ${node.ip}`;
  exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("Traceroute error:", stderr || error.message);
      return res
        .status(500)
        .json({ error: "Traceroute failed", details: stderr || error.message });
    }
    res.json({ output: stdout });
  });
});

app.post("/api/mtr", (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: "IP required" });

  const cmd = "/usr/bin/mtr";
  const args = ["--report-wide", "--report-cycles", "10", ip];

  const child = spawn(cmd, args);

  let output = "";
  child.stdout.on("data", (data) => (output += data.toString()));
  let errorOutput = "";
  child.stderr.on("data", (data) => (errorOutput += data.toString()));

  child.on("close", (code) => {
    if (code !== 0) {
      console.error("Global MTR failed:", errorOutput);
      return res.status(500).json({ error: "MTR failed", details: errorOutput });
    }
    res.json({ output });
  });
});

app.post("/api/traceroute", (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: "IP required" });

  const cmd = `traceroute ${ip}`;
  exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("Global Traceroute error:", stderr || error.message);
      return res
        .status(500)
        .json({ error: "Traceroute failed", details: stderr || error.message });
    }
    res.json({ output: stdout });
  });
});

// ============================================
// WEB UI ROUTES (OPTIMIZED)
// ============================================

app.get("/", (req, res) => {
  // OPTIMIZATION:
  // Instead of querying averaging logic for every node (N+1 queries),
  // we fetch nodes and merge with the in-memory cache.
  
  const nodes = db.prepare("SELECT * FROM nodes").all();

  const stats = nodes.map((n) => {
    const cached = nodeStatsCache[n.id] || { latency: null, jitter: 0, packetLoss1h: 0, avgJitter1h: 0 };
    return { 
      ...n, 
      latency: cached.latency, 
      packet_loss: cached.packetLoss1h, // Map 1h Avg to the 'packet_loss' field expected by template
      avgJitter: cached.avgJitter1h     // Map 1h Avg to the 'avgJitter' field expected by template
    };
  });

  const problemNodes = getProblemNodes();
  res.render("dashboard", { stats, problemNodes });
});

app.get("/node/:id", (req, res) => {
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(req.params.id);
  if (!node) return res.status(404).send("Node not found");
  res.render("node", { node });
});

app.get("/compare", (req, res) => {
  const nodes = db.prepare("SELECT id, name, ip FROM nodes ORDER BY name").all();
  res.render("compare", { nodes });
});

app.get("/vtraceroute", (req, res) => {
  res.render("vtraceroute");
});

app.get("/webhooks", (req, res) => {
  const webhooks = db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all();
  const settings = getAllSettings();
  res.render("webhooks", { webhooks, settings });
});

app.get("/settings", (req, res) => {
  const settings = getAllSettings();
  res.render("settings", { settings });
});

// ============================================
// BACKGROUND PING JOB (WITH GRACE PERIOD LOGIC)
// ============================================

cron.schedule("* * * * *", async () => {
  const nodes = db.prepare("SELECT * FROM nodes").all();

  for (const node of nodes) {
    try {
      const { latency, packetLoss, jitter } = await pingNode(node.ip, 10);
      const now = new Date().toISOString();

      // Store the ping result
      db.prepare(
        "INSERT OR IGNORE INTO ping_results (node_id, latency, packet_loss, jitter, timestamp) VALUES (?, ?, ?, ?, ?)"
      ).run(node.id, latency, packetLoss, jitter, now);

      // --- CALCULATE 1H STATS HERE (Incremental update logic) ---
      // Instead of querying on read (Dashboard load), we query on write (once per minute per node).
      // This is efficient because we do it sequentially in background.
      
      const stats1h = db.prepare(`
        SELECT AVG(packet_loss) as avgLoss, AVG(jitter) as avgJitter
        FROM ping_results 
        WHERE node_id = ? AND datetime(replace(replace(timestamp, 'T', ' '), 'Z', '')) > datetime('now', '-1 hour')
      `).get(node.id);

      // UPDATE CACHE
      nodeStatsCache[node.id] = {
        latency: latency,
        jitter: jitter,
        packetLoss1h: stats1h.avgLoss || 0,
        avgJitter1h: stats1h.avgJitter || 0
      };

      // Get current DB status
      const currentNode = db.prepare("SELECT status FROM nodes WHERE id = ?").get(node.id);
      const currentDbStatus = currentNode?.status || "offline";

      // Evaluate status with grace period logic
      const { newStatus, shouldTriggerWebhook, consecutiveFailures, consecutiveSuccesses } =
        evaluateNodeStatus(node.id, currentDbStatus);

      // Update status in DB if changed
      if (newStatus !== currentDbStatus) {
        db.prepare("UPDATE nodes SET status = ? WHERE id = ?").run(newStatus, node.id);

        // Trigger webhooks
        if (shouldTriggerWebhook) {
          console.log(
            `🔔 Status change: ${node.name} ${currentDbStatus} -> ${newStatus} ` +
              `(failures: ${consecutiveFailures}, successes: ${consecutiveSuccesses})`
          );
          await triggerWebhookAlerts(node, currentDbStatus, newStatus, {
            consecutiveFailures,
            consecutiveSuccesses,
          });
        }
      }

      // Emit real-time update
      io.emit("pingUpdate", {
        nodeId: node.id,
        latency,
        packetLoss1h: stats1h.avgLoss || 0, // Send the calculated 1h avg
        jitter,
        timestamp: now,
        status: newStatus,
        consecutiveFailures,
        consecutiveSuccesses,
      });
    } catch (err) {
      console.error("Ping error:", err);
    }
  }

  // Emit updated problem nodes
  const problemNodes = getProblemNodes();
  io.emit("problemNodesUpdate", problemNodes);

  // Prune old data
  db.prepare(
    "DELETE FROM ping_results WHERE datetime(replace(replace(timestamp, 'T', ' '), 'Z', '')) < datetime('now', '-3 months')"
  ).run();
});

// ============================================
// SOCKET.IO & SHUTDOWN
// ============================================

io.on("connection", (socket) => {
  console.log("🔌 Client connected");
  socket.on("disconnect", () => console.log("❌ Client disconnected"));
});

process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down gracefully...");
  db.close();
  process.exit(0);
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`✅ Monitoring dashboard running at http://localhost:${PORT}`);
});
