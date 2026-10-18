# 🏠 Localhost Deployment

Run OmniHilbras on your local machine for development and personal use.

---

## 📦 Installation

Install OmniHilbras globally via npm:

```bash
npm install -g @hilbras/omnihilbras
```

**Requirements:**
- Node.js 20 or higher
- npm 9 or higher

---

## 🚀 Starting the Server

Start OmniHilbras with a single command:

```bash
omnihilbras
```

The dashboard will automatically open in your browser at `http://localhost:20127`

**Default Configuration:**
- **Dashboard**: `http://localhost:20127`
- **API Endpoint**: `http://localhost:20128/v1`
- **Data Directory**: `~/.omnihilbras`

---

## 🔧 Configuration

### Custom Data Directory

Set a custom data directory using environment variable:

```bash
DATA_DIR=/path/to/data omnihilbras
```

### Custom Port

The API port (20128) and dashboard port (20127) are configured in the application. To change them, you'll need to modify the source code or use environment variables if supported.

---

## 🛑 Stopping the Server

Press `Ctrl+C` in the terminal where OmniHilbras is running.

```bash
# In the terminal running omnihilbras
^C  # Press Ctrl+C
```

The server will gracefully shut down and save all data.

---

## 🔄 Restarting the Server

Simply run the start command again:

```bash
omnihilbras
```

All your configurations, API keys, and combos are preserved in the data directory.

---

## 📊 Updating OmniHilbras

Update to the latest version:

```bash
npm update -g @hilbras/omnihilbras
```

Check your current version:

```bash
npm list -g @hilbras/omnihilbras
```

---

## 🔍 Troubleshooting

### Port Already in Use

If port 20128 or 20127 is already in use:

```bash
# Find process using the port (macOS/Linux)
lsof -i :20128
lsof -i :20127

# Kill the process
kill -9 <PID>
```

### Permission Errors

If you encounter permission errors during installation:

```bash
# Use sudo (not recommended)
sudo npm install -g @hilbras/omnihilbras

# Or fix npm permissions (recommended)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Data Directory Issues

If the data directory is not accessible:

```bash
# Check permissions
ls -la ~/.omnihilbras

# Fix permissions
chmod 755 ~/.omnihilbras
```

---

## 📁 Data Directory Structure

```
~/.omnihilbras/
├── db.json           # Main database (providers, combos, settings)
├── logs/             # Application logs
└── cache/            # Temporary cache files
```

**Backup Your Data:**

```bash
# Backup
cp -r ~/.omnihilbras ~/.omnihilbras.backup

# Restore
cp -r ~/.omnihilbras.backup ~/.omnihilbras
```

---

## 🔗 Next Steps

- [Connect Providers](/providers/subscription.md)
- [Create Combos](/features/combos.md)
- [Integrate with CLI Tools](/integration/cursor.md)
