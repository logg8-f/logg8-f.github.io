#!/bin/sh
# Daily snapshot of the Quizlet shared data file.
#
# Kept in the repo so the deployment can be rebuilt; installed to
# /usr/local/bin/quizlet-backup.sh on the server.
set -eu

DATA=/opt/quizlet/data/db.json
OWNERS=/opt/quizlet/data/owners.json
DEST=/opt/quizlet/backups
KEEP=14

mkdir -p "$DEST"
STAMP=$(date +%F)
if [ -f "$DATA" ]; then
  cp -f "$DATA" "$DEST/db-$STAMP.json"
fi
# The ownership file records which write token may change each document.
# Without it, a restore would lose that protection (documents would go back
# to being first-writer-wins), so it is snapshotted alongside the data.
if [ -f "$OWNERS" ]; then
  cp -f "$OWNERS" "$DEST/owners-$STAMP.json"
fi

# Keep the newest $KEEP snapshots of each kind, delete anything older.
ls -1t "$DEST"/db-*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "$DEST"/owners-*.json 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
