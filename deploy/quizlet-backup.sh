#!/bin/sh
# Daily snapshot of the Quizlet shared data file.
#
# Kept in the repo so the deployment can be rebuilt; installed to
# /usr/local/bin/quizlet-backup.sh on the server.
set -eu

DATA=/opt/quizlet/data/db.json
DEST=/opt/quizlet/backups
KEEP=14

mkdir -p "$DEST"
if [ -f "$DATA" ]; then
  cp -f "$DATA" "$DEST/db-$(date +%F).json"
fi

# Keep the newest $KEEP snapshots, delete anything older.
ls -1t "$DEST"/db-*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
