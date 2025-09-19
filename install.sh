#!/bin/bash
set -e

APP_NAME="beanping"
APP_USER="beanping"
APP_DIR="/opt/$APP_NAME"
SERVICE_FILE="/etc/systemd/system/$APP_NAME.service"

echo "📡 Installing $APP_NAME..."

# --- 1. Install system dependencies ---
echo "🔧 Installing dependencies..."
if [ -x "$(command -v apt-get)" ]; then
  sudo apt-get update
  sudo apt-get install -y curl sqlite3 traceroute mtr
elif [ -x "$(command -v yum)" ]; then
  sudo yum install -y curl sqlite sqlite-devel traceroute mtr
else
  echo "❌ Unsupported package manager. Install curl, sqlite3, traceroute, mtr manually."
  exit 1
fi

# --- 2. Setup non-root user ---
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  echo "👤 Creating user $APP_USER..."
  sudo useradd -r -s /bin/false $APP_USER
fi

# --- 3. Setup app directory ---
echo "📁 Setting up application directory at $APP_DIR..."
sudo mkdir -p "$APP_DIR"
sudo cp -r ./* "$APP_DIR"
sudo chown -R $APP_USER:$APP_USER "$APP_DIR"

# --- 4. Install Node.js (if not installed) ---
if ! command -v node >/dev/null 2>&1; then
  echo "📦 Installing Node.js (LTS)..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# --- 5. Install npm dependencies ---
echo "📦 Installing Node.js packages..."
cd "$APP_DIR"
sudo -u $APP_USER npm install --production

# --- 6. Create systemd service ---
echo "⚙️ Creating systemd service..."
sudo bash -c "cat > $SERVICE_FILE" <<EOF
[Unit]
Description=BeanPing Monitoring Dashboard
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(which node) $APP_DIR/monitor.js
Restart=always
Environment=NODE_ENV=production
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=$APP_NAME

[Install]
WantedBy=multi-user.target
EOF

# --- 7. Enable + start service ---
echo "🚀 Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable $APP_NAME
sudo systemctl restart $APP_NAME

echo "✅ $APP_NAME installed successfully!"
echo "👉 Access the dashboard at: http://localhost:3000"
echo "ℹ️ Logs: journalctl -u $APP_NAME -f"
