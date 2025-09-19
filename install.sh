#!/bin/bash
set -e

APP_NAME="beanping"
APP_USER="beanping"

# use the current directory as app dir
APP_DIR="$(pwd)"
SERVICE_FILE="/etc/systemd/system/$APP_NAME.service"

echo "📡 Installing $APP_NAME from $APP_DIR ..."

# --- SAFETY CHECK: prevent installing in /root ---
if [[ "$APP_DIR" == /root* ]]; then
  echo "❌ ERROR: Cannot install $APP_NAME inside /root."
  echo "👉 Please clone the repo into a user or service directory like /srv/$APP_NAME or /opt/$APP_NAME."
  exit 1
fi

# --- 1. Install system dependencies ---
echo "🔧 Installing dependencies..."
if [ -x "$(command -v apt-get)" ]; then
  apt-get update
  apt-get install -y curl sqlite3 traceroute mtr
elif [ -x "$(command -v yum)" ]; then
  yum install -y curl sqlite sqlite-devel traceroute mtr
else
  echo "❌ Unsupported package manager. Install curl, sqlite3, traceroute, mtr manually."
  exit 1
fi

# --- 2. Setup non-root user ---
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  echo "👤 Creating user $APP_USER..."
  useradd -r -s /bin/false $APP_USER
fi

# --- 3. Ensure correct permissions on repo ---
echo "📁 Setting ownership of repo to $APP_USER ..."
chown -R $APP_USER:$APP_USER "$APP_DIR"

# --- 4. Install Node.js (if not installed) ---
if ! command -v node >/dev/null 2>&1; then
  echo "📦 Installing Node.js (LTS 18)..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi

# --- 5. Install npm dependencies (root installs, user runs) ---
echo "📦 Installing Node.js packages..."
npm install --production

# --- 6. Create systemd service ---
echo "⚙️ Creating systemd service..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=BeanPing Monitoring Dashboard
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(which node) $APP_DIR/monitor.js
Restart=always
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$APP_NAME

[Install]
WantedBy=multi-user.target
EOF

# --- 7. Enable + start service ---
echo "🚀 Enabling and starting systemd service..."
systemctl daemon-reload
systemctl enable $APP_NAME
systemctl restart $APP_NAME

echo "✅ $APP_NAME installed successfully!"
echo "👉 Access the dashboard at: http://localhost:3000"
echo "ℹ️ Logs: journalctl -u $APP_NAME -f"
