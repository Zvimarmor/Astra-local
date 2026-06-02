# Mac Mini M4 Setup Guide — Astra Local Agent

This guide walks you through everything needed to get Astra running on the Mac Mini M4 when the hardware arrives.

## 1. Initial Mac Mini Setup

### 1.1 Physical Setup
- Connect the Mac Mini to power and ethernet (or WiFi)
- Plug in an **HDMI Dummy Plug** so the system boots with GPU acceleration enabled even without a monitor
- Complete macOS initial setup (create user account, enable remote login)

### 1.2 Enable Remote Access
```bash
# Enable SSH
sudo systemsetup -setremotelogin on

# Enable Screen Sharing (VNC)
sudo defaults write /var/db/launchd.db/com.apple.launchd/overrides.plist com.apple.screensharing -dict Disabled -bool false
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist
```

From your iPad or other Mac, connect via:
- **Screen Sharing**: `vnc://mac-mini-ip-address`
- **SSH**: `ssh username@mac-mini-ip-address`

### 1.3 Prevent Sleep
```bash
# Disable sleep entirely (server mode)
sudo pmset -a sleep 0
sudo pmset -a disksleep 0
sudo pmset -a displaysleep 0

# Enable auto-restart after power failure
sudo pmset -a autorestart 1
```

---

## 2. Install Dependencies

### 2.1 Homebrew
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2.2 Node.js (LTS)
```bash
brew install node
```

### 2.3 Git
```bash
brew install git
```

### 2.4 Docker (Optional — for Immich or other containerized services)
```bash
brew install --cask docker
```

---

## 3. Install Ollama (Local LLM)

### 3.1 Install
```bash
brew install ollama
```

### 3.2 Start Ollama Server
```bash
# Start as a background service (auto-starts on boot)
brew services start ollama
```

### 3.3 Pull Models
```bash
# Primary model — good at tool calling and instruction following
ollama pull nous-hermes

# Fallback / alternative
ollama pull llama3

# Verify
ollama list
```

### 3.4 Verify Endpoint
```bash
# Should return a JSON response
curl http://localhost:11434/api/tags
```

---

## 4. Install OpenClaw

### 4.1 Install
```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 4.2 Onboard
```bash
openclaw onboard
```

During onboarding:
- **Model provider**: Select `Ollama`
- **Endpoint**: `http://localhost:11434`
- **Model**: `nous-hermes`
- **Channels**: Enable WhatsApp

### 4.3 Configure
The `openclaw.json` in this project is pre-configured. Copy it to the OpenClaw config directory or point OpenClaw to this project:
```bash
cd ~/MyProjects/Astra
openclaw start --config ./openclaw.json
```

---

## 5. Install Piper (Local TTS)

### 5.1 Install Piper
```bash
brew install piper
```

### 5.2 Download English Voice Model
```bash
# Download a high-quality English voice
mkdir -p ~/piper-voices
cd ~/piper-voices
curl -L -O https://github.com/rhasspy/piper/releases/download/v1.2.0/voice-en-us-amy-medium.tar.gz
tar xzf voice-en-us-amy-medium.tar.gz
```

### 5.3 Test
```bash
echo "Hello, I am Astra, your personal assistant." | piper --model ~/piper-voices/en-us-amy-medium.onnx --output_file test.wav
afplay test.wav
```

---

## 6. Deploy Astra

### 6.1 Clone the Project
```bash
cd ~/MyProjects
git clone https://github.com/Zvimarmor/Astra.git
cd Astra
```

### 6.2 Install Dependencies
```bash
npm install
npm run build
```

### 6.3 Configure Environment
```bash
cp .env.example .env
# Edit .env with your actual values:
# - OWNER_PHONE_NUMBER
# - CALENDAR_ID
# - SERVICE_ACCOUNT_PATH (copy service_account.json to data/)
nano .env
```

### 6.4 Copy Service Account
```bash
# Copy from the existing WhatsApp Bot project (same credentials)
cp ~/MyProjects/WhatsApp_Bot/service_account.json ~/MyProjects/Astra/data/service_account.json
```

### 6.5 Start Astra
```bash
openclaw start --config ./openclaw.json
```

### 6.6 WhatsApp Authentication
On first run, OpenClaw will display a QR code. Scan it with WhatsApp on your phone to link the device.

---

## 7. Auto-Start on Boot (launchd)

Create a launch agent so Astra starts automatically when the Mac Mini boots:

```bash
cat > ~/Library/LaunchAgents/com.astra.agent.plist << 'EOF'
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
        <string>/Users/YOUR_USERNAME/MyProjects/Astra/openclaw.json</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/MyProjects/Astra</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/MyProjects/Astra/data/astra.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/MyProjects/Astra/data/astra-error.log</string>
</dict>
</plist>
EOF

# Load it
launchctl load ~/Library/LaunchAgents/com.astra.agent.plist
```

> ⚠️ Replace `YOUR_USERNAME` with your actual macOS username.

---

## 8. Verify Everything Works

| Check | Command | Expected |
|---|---|---|
| Ollama running | `curl localhost:11434/api/tags` | JSON with model list |
| Model loaded | `ollama run nous-hermes "Hello"` | Text response |
| OpenClaw running | `openclaw status` | Shows active gateway |
| WhatsApp connected | Send "ping" to self on WhatsApp | Astra responds |
| Calendar works | Ask "What's on my calendar?" | Lists events |
| Tasks work | Ask "Add task: test the system" | Confirms task added |
| Piper TTS | `echo "test" \| piper --model ...` | Audio output |

---

## 9. External Storage Setup (SanDisk Extreme 1TB)

For heavy media and photos (Immich, etc.):
```bash
# The SSD should auto-mount. Verify:
ls /Volumes/

# Create a symlink for easy access
ln -s /Volumes/SanDisk_Extreme ~/ExternalSSD
```

---

## 10. Future: Exo Distributed Computing (iPad)

> **Note**: This is exploratory. The iPad may not always be on the network.

If you want to use the iPad as additional compute for running larger models:
```bash
# Install exo on the Mac Mini
pip install exo

# On the iPad (via a-Shell or similar):
# pip install exo

# Start the coordinator on Mac Mini
exo start --coordinator

# Join from iPad
exo join --coordinator-ip mac-mini-ip
```

See the [exo project](https://github.com/exo-explore/exo) for full docs.
