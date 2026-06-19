#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  Astra Mac Mini M4 — Automated Setup Script
#
#  Usage:
#    chmod +x scripts/setup.sh
#    ./scripts/setup.sh
#
#  This script is idempotent — safe to run multiple times.
#  It checks if each dependency is already installed before acting.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Colors & Formatting ─────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

STEP=0

step() {
    STEP=$((STEP + 1))
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}  Step ${STEP}: $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (already installed)"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${CYAN}ℹ${NC} $1"; }

# ─── Detect Username & Paths ─────────────────────────────────────
CURRENT_USER=$(whoami)
PROJECT_DIR="$HOME/MyProjects/Astra"
PIPER_VOICES_DIR="$HOME/piper-voices"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Astra — Mac Mini M4 Setup Script              ║${NC}"
echo -e "${BOLD}║       Setting up for user: ${CYAN}${CURRENT_USER}${NC}${BOLD}                      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"

# ═══════════════════════════════════════════════════════════════════
#  Step 1: macOS Server Mode (Prevent Sleep)
# ═══════════════════════════════════════════════════════════════════
step "Configure macOS Server Mode"

info "Disabling sleep (requires sudo)..."
sudo pmset -a sleep 0 2>/dev/null && ok "sleep disabled" || warn "Could not set sleep"
sudo pmset -a disksleep 0 2>/dev/null && ok "disk sleep disabled" || warn "Could not set disk sleep"
sudo pmset -a displaysleep 0 2>/dev/null && ok "display sleep disabled" || warn "Could not set display sleep"
sudo pmset -a autorestart 1 2>/dev/null && ok "auto-restart after power failure enabled" || warn "Could not set auto-restart"

# ═══════════════════════════════════════════════════════════════════
#  Step 2: Enable SSH
# ═══════════════════════════════════════════════════════════════════
step "Enable Remote Access (SSH)"

if sudo systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
    skip "SSH remote login"
else
    sudo systemsetup -setremotelogin on 2>/dev/null && ok "SSH enabled" || warn "Could not enable SSH"
fi

info "Connect from another device: ssh ${CURRENT_USER}@\$(hostname)"

# ═══════════════════════════════════════════════════════════════════
#  Step 3: Homebrew
# ═══════════════════════════════════════════════════════════════════
step "Install Homebrew"

if command -v brew &>/dev/null; then
    skip "Homebrew ($(brew --version | head -1))"
else
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add to PATH for Apple Silicon
    if [[ -f /opt/homebrew/bin/brew ]]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
        eval "$(/opt/homebrew/bin/brew shellenv)"
        ok "Homebrew installed + PATH configured for Apple Silicon"
    else
        ok "Homebrew installed"
    fi
fi

# Ensure brew is in PATH for the rest of this script
if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 4: Node.js
# ═══════════════════════════════════════════════════════════════════
step "Install Node.js (LTS)"

if command -v node &>/dev/null; then
    skip "Node.js ($(node --version))"
else
    brew install node
    ok "Node.js installed ($(node --version))"
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 5: Git
# ═══════════════════════════════════════════════════════════════════
step "Install Git"

if command -v git &>/dev/null; then
    skip "Git ($(git --version))"
else
    brew install git
    ok "Git installed ($(git --version))"
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 6: Ollama (Local LLM)
# ═══════════════════════════════════════════════════════════════════
step "Install Ollama"

if command -v ollama &>/dev/null; then
    skip "Ollama"
else
    brew install ollama
    ok "Ollama installed"
fi

# Start Ollama service
if brew services list 2>/dev/null | grep ollama | grep -q started; then
    skip "Ollama service (already running)"
else
    brew services start ollama
    ok "Ollama service started"
    info "Waiting 5s for Ollama to initialize..."
    sleep 5
fi

# Pull models
info "Pulling LLM models (this may take a while)..."
if ollama list 2>/dev/null | grep -q "hermes3:8b-llama3.1-q8_0"; then
    skip "Model: hermes3:8b-llama3.1-q8_0"
else
    ollama pull hermes3:8b-llama3.1-q8_0 && ok "Pulled: hermes3:8b-llama3.1-q8_0" || warn "Failed to pull hermes3:8b-llama3.1-q8_0"
fi

if ollama list 2>/dev/null | grep -q "hermes3"; then
    skip "Model: hermes3 (fallback)"
else
    ollama pull hermes3 && ok "Pulled: hermes3 (fallback)" || warn "Failed to pull hermes3"
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 7: Piper (Local TTS)
# ═══════════════════════════════════════════════════════════════════
step "Install Piper (Text-to-Speech)"

if command -v piper &>/dev/null; then
    skip "Piper"
else
    brew install piper
    ok "Piper installed"
fi

# Download voice model
mkdir -p "$PIPER_VOICES_DIR"
if [[ -f "$PIPER_VOICES_DIR/en-us-amy-medium.onnx" ]]; then
    skip "Piper voice model (en-us-amy-medium)"
else
    info "Downloading English voice model..."
    cd "$PIPER_VOICES_DIR"
    curl -L -O "https://github.com/rhasspy/piper/releases/download/v1.2.0/voice-en-us-amy-medium.tar.gz" 2>/dev/null
    tar xzf voice-en-us-amy-medium.tar.gz 2>/dev/null
    rm -f voice-en-us-amy-medium.tar.gz
    ok "Voice model downloaded"
    cd -
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 8: Docker (Optional)
# ═══════════════════════════════════════════════════════════════════
step "Docker (Optional)"

if command -v docker &>/dev/null; then
    skip "Docker ($(docker --version 2>/dev/null | head -1))"
else
    read -p "  Install Docker Desktop? (y/N): " INSTALL_DOCKER
    if [[ "${INSTALL_DOCKER:-n}" =~ ^[Yy] ]]; then
        brew install --cask docker
        ok "Docker Desktop installed (launch it manually to complete setup)"
    else
        info "Skipping Docker (can install later with: brew install --cask docker)"
    fi
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 9: Clone & Build Astra
# ═══════════════════════════════════════════════════════════════════
step "Clone & Build Astra"

mkdir -p "$HOME/MyProjects"

if [[ -d "$PROJECT_DIR/.git" ]]; then
    skip "Astra repository (already cloned)"
    cd "$PROJECT_DIR"
    info "Pulling latest changes..."
    git pull --ff-only 2>/dev/null && ok "Updated to latest" || warn "Could not pull (check for local changes)"
else
    cd "$HOME/MyProjects"
    git clone https://github.com/Zvimarmor/Astra-local.git Astra
    ok "Cloned Astra repository"
    cd "$PROJECT_DIR"
fi

info "Installing npm dependencies..."
npm install --silent 2>/dev/null
ok "npm install complete"

info "Building TypeScript (tools)..."
npm run build 2>/dev/null
ok "npm run build complete"

info "Building TypeScript (services)..."
npm run build:services 2>/dev/null
ok "npm run build:services complete"

# ═══════════════════════════════════════════════════════════════════
#  Step 10: Configure Environment
# ═══════════════════════════════════════════════════════════════════
step "Configure Environment (.env)"

if [[ -f "$PROJECT_DIR/.env" ]]; then
    skip ".env file (already exists)"
    warn "Review your .env file to make sure all values are filled in"
else
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    ok "Created .env from .env.example"
    echo ""
    warn "You MUST edit .env with your actual values:"
    info "  - OWNER_PHONE_NUMBER (your WhatsApp number with country code)"
    info "  - CALENDAR_ID (Google Calendar ID)"
    info "  - IMAP_USER / IMAP_PASSWORD (Gmail App Password)"
    info "  - DASHBOARD_TOKEN (generate with: openssl rand -hex 16)"
    echo ""
    read -p "  Open .env in nano now? (Y/n): " EDIT_ENV
    if [[ "${EDIT_ENV:-y}" =~ ^[Yy] ]]; then
        nano "$PROJECT_DIR/.env"
    fi
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 11: Service Account
# ═══════════════════════════════════════════════════════════════════
step "Google Service Account"

mkdir -p "$PROJECT_DIR/data"

if [[ -f "$PROJECT_DIR/data/service_account.json" ]]; then
    skip "service_account.json (already in place)"
else
    SA_SOURCE="$HOME/MyProjects/WhatsApp_Bot/service_account.json"
    if [[ -f "$SA_SOURCE" ]]; then
        cp "$SA_SOURCE" "$PROJECT_DIR/data/service_account.json"
        ok "Copied service_account.json from WhatsApp_Bot"
    else
        warn "service_account.json not found!"
        info "Copy it manually: cp /path/to/service_account.json $PROJECT_DIR/data/"
    fi
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 12: Create Media Directories
# ═══════════════════════════════════════════════════════════════════
step "Create Data Directories"

mkdir -p "$PROJECT_DIR/data/media/whatsapp"
mkdir -p "$PROJECT_DIR/data/media/tts"
mkdir -p "$PROJECT_DIR/data/whatsapp_auth"
ok "Created data directories"

# ═══════════════════════════════════════════════════════════════════
#  Step 13: Generate Dashboard Token
# ═══════════════════════════════════════════════════════════════════
step "Generate Dashboard Token"

if grep -q "DASHBOARD_TOKEN=." "$PROJECT_DIR/.env" 2>/dev/null; then
    skip "Dashboard token (already set in .env)"
else
    DASH_TOKEN=$(openssl rand -hex 16)
    if grep -q "DASHBOARD_TOKEN" "$PROJECT_DIR/.env" 2>/dev/null; then
        # Replace existing empty token
        sed -i '' "s/DASHBOARD_TOKEN=.*/DASHBOARD_TOKEN=${DASH_TOKEN}/" "$PROJECT_DIR/.env"
    else
        echo "" >> "$PROJECT_DIR/.env"
        echo "# Dashboard (health check)" >> "$PROJECT_DIR/.env"
        echo "DASHBOARD_TOKEN=${DASH_TOKEN}" >> "$PROJECT_DIR/.env"
    fi
    ok "Generated dashboard token"
    info "Token: ${DASH_TOKEN}"
    info "Save this! You'll need it to access the dashboard."
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 14: Create launchd Plists (Auto-Start)
# ═══════════════════════════════════════════════════════════════════
step "Create launchd Auto-Start Services"

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_AGENTS_DIR"

# ─── Astra Agent ─────────────────────────────────────────────────
ASTRA_PLIST="$LAUNCH_AGENTS_DIR/com.astra.agent.plist"
if [[ -f "$ASTRA_PLIST" ]]; then
    skip "Astra agent plist"
else
    cat > "$ASTRA_PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.astra.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/openclaw</string>
        <string>start</string>
        <string>--config</string>
        <string>${PROJECT_DIR}/openclaw.json</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/data/astra.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/data/astra-error.log</string>
</dict>
</plist>
PLIST_EOF
    ok "Created Astra agent plist"
fi

# ─── WhatsApp Listener ──────────────────────────────────────────
LISTENER_PLIST="$LAUNCH_AGENTS_DIR/com.astra.whatsapp-listener.plist"
if [[ -f "$LISTENER_PLIST" ]]; then
    skip "WhatsApp listener plist"
else
    cat > "$LISTENER_PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.astra.whatsapp-listener</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>${PROJECT_DIR}/dist-services/whatsapp-listener.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/data/whatsapp-listener.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/data/whatsapp-listener-error.log</string>
</dict>
</plist>
PLIST_EOF
    ok "Created WhatsApp listener plist"
fi

# ─── Dashboard ──────────────────────────────────────────────────
DASHBOARD_PLIST="$LAUNCH_AGENTS_DIR/com.astra.dashboard.plist"
if [[ -f "$DASHBOARD_PLIST" ]]; then
    skip "Dashboard plist"
else
    cat > "$DASHBOARD_PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.astra.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>${PROJECT_DIR}/dist-services/dashboard.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/data/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/data/dashboard-error.log</string>
</dict>
</plist>
PLIST_EOF
    ok "Created Dashboard plist"
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 15: Install Log Rotation
# ═══════════════════════════════════════════════════════════════════
step "Configure Log Rotation"

LOGROTATE_CONF="/etc/newsyslog.d/astra.conf"
if [[ -f "$LOGROTATE_CONF" ]]; then
    skip "Log rotation config"
else
    if [[ -f "$PROJECT_DIR/scripts/logrotate.conf" ]]; then
        sudo cp "$PROJECT_DIR/scripts/logrotate.conf" "$LOGROTATE_CONF"
        ok "Installed log rotation config"
    else
        warn "logrotate.conf not found in scripts/ — skipping"
    fi
fi

# ═══════════════════════════════════════════════════════════════════
#  Step 16: Enable WhatsApp Channel
# ═══════════════════════════════════════════════════════════════════
step "Enable WhatsApp Channel"

if grep -q '"enabled": true' "$PROJECT_DIR/openclaw.json" 2>/dev/null; then
    skip "WhatsApp channel (already enabled)"
else
    read -p "  Enable WhatsApp channel in openclaw.json? (Y/n): " ENABLE_WA
    if [[ "${ENABLE_WA:-y}" =~ ^[Yy] ]]; then
        sed -i '' 's/"enabled": false/"enabled": true/' "$PROJECT_DIR/openclaw.json"
        ok "WhatsApp channel enabled"
    else
        info "Skipped — WhatsApp remains disabled (CLI only)"
    fi
fi

# ═══════════════════════════════════════════════════════════════════
#  Verification Checklist
# ═══════════════════════════════════════════════════════════════════
step "Verification Checklist"

echo ""
echo -e "${BOLD}  Running checks...${NC}"
echo ""

# Check Ollama
if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama is running"
else
    warn "Ollama is not responding (start with: brew services start ollama)"
fi

# Check models
if ollama list 2>/dev/null | grep -q "hermes3:8b-llama3.1-q8_0"; then
    ok "Model 'hermes3:8b-llama3.1-q8_0' is available"
else
    warn "Model 'hermes3:8b-llama3.1-q8_0' not found (pull with: ollama pull hermes3:8b-llama3.1-q8_0)"
fi

# Check Node
if command -v node &>/dev/null; then
    ok "Node.js $(node --version) is available"
else
    fail "Node.js not found"
fi

# Check project build
if [[ -d "$PROJECT_DIR/dist" ]]; then
    ok "Project built (dist/ exists)"
else
    warn "dist/ not found — run: npm run build"
fi

# Check .env
if [[ -f "$PROJECT_DIR/.env" ]]; then
    if grep -q "OWNER_PHONE_NUMBER=972" "$PROJECT_DIR/.env" 2>/dev/null || grep -q "OWNER_PHONE_NUMBER=1" "$PROJECT_DIR/.env" 2>/dev/null; then
        ok ".env configured"
    else
        warn ".env exists but OWNER_PHONE_NUMBER may not be set"
    fi
else
    fail ".env not found"
fi

# Check service account
if [[ -f "$PROJECT_DIR/data/service_account.json" ]]; then
    ok "service_account.json in place"
else
    warn "service_account.json missing (Google Calendar won't work)"
fi

# Check Piper
if command -v piper &>/dev/null; then
    ok "Piper TTS installed"
else
    warn "Piper not found (voice features won't work)"
fi

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                  Setup Complete! 🎉                 ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "    1. Review .env:          ${YELLOW}nano $PROJECT_DIR/.env${NC}"
echo -e "    2. Start Astra:          ${YELLOW}cd $PROJECT_DIR && openclaw start --config ./openclaw.json${NC}"
echo -e "    3. Scan WhatsApp QR:     ${YELLOW}(will appear in terminal on first run)${NC}"
echo -e "    4. Load auto-start:      ${YELLOW}launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.astra.agent.plist${NC}"
echo -e "    5. Start dashboard:      ${YELLOW}launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.astra.dashboard.plist${NC}"
echo -e "    6. Access dashboard:     ${YELLOW}ssh -L 3001:localhost:3001 ${CURRENT_USER}@mac-mini-ip${NC}"
echo -e "                             ${YELLOW}then open http://localhost:3001?token=YOUR_TOKEN${NC}"
echo ""
