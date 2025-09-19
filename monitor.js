// monitor.js (10 pings per node per minute, jitter = std deviation, problem nodes live updates)
const express = require("express");
const bodyParser = require("body-parser");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { exec, spawn } = require("child_process");
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let db = new Database("monitor.db");

// Setup multer for file uploads
const upload = multer({ dest: 'temp-uploads/' });

// Create temp-uploads directory if it doesn't exist
if (!fs.existsSync('temp-uploads')) {
  fs.mkdirSync('temp-uploads');
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
`);

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "views"))); // serve CSS/JS
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Helper: run 10 pings and parse results
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
          avgLatency = parseFloat(parts[1]); // avg
          jitter = parseFloat(parts[3]); // mdev = std deviation
        }

        // ✅ Keep NULL values when offline - don't force to 0
        resolve({ latency: avgLatency, packetLoss, jitter });
      } else {
        // ✅ Complete failure - keep as NULL
        resolve({ latency: null, packetLoss: 100, jitter: null });
      }
    });
  });
}

// ✅ Updated Helper: get problem nodes (threshold = 4)
function getProblemNodes() {
  return db
    .prepare(
      `SELECT n.id, n.name, n.ip,
              SUM(CASE WHEN p.packet_loss = 10 THEN 1 ELSE 0 END) as loss10Count,
              SUM(CASE WHEN p.packet_loss > 10 THEN 1 ELSE 0 END) as highLossCount,
              SUM(CASE WHEN p.jitter > 50 THEN 1 ELSE 0 END) as highJitterCount
       FROM nodes n
       JOIN ping_results p ON n.id = p.node_id
       -- normalize ISO8601 timestamps so SQLite can parse them
       WHERE datetime(replace(replace(p.timestamp, 'T', ' '), 'Z', '')) > datetime('now', '-1 hour')
       GROUP BY n.id
       HAVING loss10Count >= 4 OR highLossCount >= 4 OR highJitterCount >= 4`
    )
    .all();
}

// API: Backup database
app.get('/api/backup', (req, res) => {
  const dbPath = path.join(__dirname, 'monitor.db');
  
  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ error: 'Database file not found' });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `beanping-backup-${timestamp}.db`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  
  const fileStream = fs.createReadStream(dbPath);
  fileStream.pipe(res);
});

// API: Restore database
app.post('/api/restore', upload.single('backup'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No backup file provided' });
  }

  try {
    const uploadedPath = req.file.path;
    const dbPath = path.join(__dirname, 'monitor.db');
    
    // Validate the uploaded file is a valid SQLite database
    let testDb;
    try {
      testDb = new Database(uploadedPath);
      // Test if it has the expected tables
      const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = tables.map(t => t.name);
      
      if (!tableNames.includes('nodes') || !tableNames.includes('ping_results')) {
        throw new Error('Invalid database structure');
      }
      testDb.close();
    } catch (error) {
      fs.unlinkSync(uploadedPath); // Clean up
      return res.status(400).json({ error: 'Invalid database file' });
    }

    // Backup current database
    const backupPath = `${dbPath}.backup-${Date.now()}`;
    fs.copyFileSync(dbPath, backupPath);

    // Close current database connection
    db.close();

    // Replace database file
    fs.copyFileSync(uploadedPath, dbPath);
    
    // Clean up uploaded file
    fs.unlinkSync(uploadedPath);

    // Reconnect to new database
    db = new Database("monitor.db");

    res.json({ success: true, message: 'Database restored successfully' });

    // Restart the application to reinitialize everything
    setTimeout(() => {
      process.exit(0); // PM2 or similar process manager should restart it
    }, 1000);

  } catch (error) {
    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.error('Restore error:', error);
    res.status(500).json({ error: 'Failed to restore database: ' + error.message });
  }
});

// API: Add node
app.post("/api/nodes", (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: "Invalid input" });
  const stmt = db.prepare("INSERT INTO nodes (name, ip) VALUES (?, ?)");
  const result = stmt.run(name, ip);
  io.emit("nodeAdded", { id: result.lastInsertRowid, name, ip });
  res.json({ id: result.lastInsertRowid, name, ip });
});

// API: Update node (rename / change IP)
app.put("/api/nodes/:id", (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: "Invalid input" });
  db.prepare("UPDATE nodes SET name = ?, ip = ? WHERE id = ?").run(name, ip, req.params.id);
  io.emit("nodeUpdated", { id: req.params.id, name, ip });
  res.json({ success: true });
});

// API: Delete node
app.delete("/api/nodes/:id", (req, res) => {
  db.prepare("DELETE FROM nodes WHERE id = ?").run(req.params.id);
  io.emit("nodeRemoved", { id: req.params.id });
  res.json({ success: true });
});

// API: Get node stats with time range
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

// ✅ API: Run MTR for a specific node
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

// ✅ API: Run traceroute for a specific node
app.get("/api/nodes/:id/traceroute", (req, res) => {
  const { id } = req.params;
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
  if (!node) return res.status(404).json({ error: "Node not found" });

  const cmd = `traceroute ${node.ip}`;
  exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("Traceroute error:", stderr || error.message);
      return res.status(500).json({ error: "Traceroute failed", details: stderr || error.message });
    }
    res.json({ output: stdout });
  });
});

// ✅ API: Run global MTR (custom IP)
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

// ✅ API: Run global traceroute (custom IP)
app.post("/api/traceroute", (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: "IP required" });

  const cmd = `traceroute ${ip}`;
  exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
    if (error) {
      console.error("Global Traceroute error:", stderr || error.message);
      return res.status(500).json({ error: "Traceroute failed", details: stderr || error.message });
    }
    res.json({ output: stdout });
  });
});

// WebUI: Dashboard
app.get("/", (req, res) => {
  const nodes = db.prepare("SELECT * FROM nodes").all();

  const stats = nodes.map((n) => {
    const last = db
      .prepare(
        "SELECT latency, packet_loss, jitter, timestamp FROM ping_results WHERE node_id = ? ORDER BY timestamp DESC LIMIT 1"
      )
      .get(n.id);

    // ✅ AVG() automatically ignores NULL values
    const jitterRow = db
      .prepare(
        "SELECT AVG(jitter) as avgJitter FROM ping_results WHERE node_id = ? AND datetime(replace(replace(timestamp, 'T', ' '), 'Z', '')) > datetime('now', '-1 hour')"
      )
      .get(n.id);

    return { ...n, ...last, avgJitter: jitterRow?.avgJitter || 0 };
  });

  const problemNodes = getProblemNodes();
  res.render("dashboard", { stats, problemNodes });
});

// WebUI: Node detail
app.get("/node/:id", (req, res) => {
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(req.params.id);
  if (!node) return res.status(404).send("Node not found");
  res.render("node", { node });
});

// WebUI: Compare nodes page
app.get("/compare", (req, res) => {
  const nodes = db.prepare("SELECT id, name, ip FROM nodes ORDER BY name").all();
  res.render("compare", { nodes });
});

// WebUI: Visual traceroute page
app.get("/vtraceroute", (req, res) => {
  res.render("vtraceroute");
});

// Background Ping Job (every minute)
cron.schedule("* * * * *", async () => {
  const nodes = db.prepare("SELECT * FROM nodes").all();
  for (const node of nodes) {
    try {
      const { latency, packetLoss, jitter } = await pingNode(node.ip, 10);
      const now = new Date().toISOString(); // keep ISO for graphs

      // ✅ Store NULL values as-is (don't convert to 0)
      db.prepare(
        "INSERT OR IGNORE INTO ping_results (node_id, latency, packet_loss, jitter, timestamp) VALUES (?, ?, ?, ?, ?)"
      ).run(node.id, latency, packetLoss, jitter, now);

      db.prepare("UPDATE nodes SET status = ? WHERE id = ?").run(
        packetLoss < 100 ? "online" : "offline",
        node.id
      );

      io.emit("pingUpdate", {
        nodeId: node.id,
        latency,
        packetLoss,
        jitter,
        timestamp: now,
        status: packetLoss < 100 ? "online" : "offline"
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

// Socket.IO connection
io.on("connection", (socket) => {
  console.log("🔌 Client connected");
  socket.on("disconnect", () => console.log("❌ Client disconnected"));
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  db.close();
  process.exit(0);
});

// Start server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`✅ Monitoring dashboard running at http://localhost:${PORT}`);
});