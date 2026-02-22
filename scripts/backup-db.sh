#!/bin/bash
# DumpsterMap SQLite Backup Script
# Downloads production DB and uploads to Google Drive

set -e

BACKUP_DIR="$HOME/clawd/dumpstermap/backups"
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_FILE="dumpstermap_${TIMESTAMP}.db"
GDRIVE_FOLDER_ID="170KxKCInqkgZQp3bw-bUjbRNPwOdZfH-"
GOG_ACCOUNT="carygreenwood@gmail.com"

echo "🗄️ Starting DumpsterMap backup..."

# 1. Download from Fly.io
echo "📥 Downloading from Fly.io..."
cd ~/clawd/dumpstermap
fly sftp get /data/dumpstermap.db "$BACKUP_DIR/$BACKUP_FILE" 2>/dev/null

if [ ! -f "$BACKUP_DIR/$BACKUP_FILE" ]; then
    echo "❌ Failed to download database"
    exit 1
fi

# Get file size
SIZE=$(ls -lh "$BACKUP_DIR/$BACKUP_FILE" | awk '{print $5}')
echo "✅ Downloaded: $BACKUP_FILE ($SIZE)"

# 2. Upload to Google Drive
echo "📤 Uploading to Google Drive..."
gog drive upload "$BACKUP_DIR/$BACKUP_FILE" --parent "$GDRIVE_FOLDER_ID" --account "$GOG_ACCOUNT"

echo "✅ Uploaded to Google Drive"

# 3. Cleanup old local backups (keep last 7)
echo "🧹 Cleaning old local backups..."
ls -t "$BACKUP_DIR"/dumpstermap_*.db 2>/dev/null | tail -n +8 | xargs -r rm -f

# 4. Show stats
LOCAL_COUNT=$(ls "$BACKUP_DIR"/dumpstermap_*.db 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "📊 Backup complete!"
echo "   File: $BACKUP_FILE"
echo "   Size: $SIZE"
echo "   Local backups: $LOCAL_COUNT (keeping last 7)"
echo "   Google Drive: https://drive.google.com/drive/folders/$GDRIVE_FOLDER_ID"
