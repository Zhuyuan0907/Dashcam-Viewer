#!/bin/bash
# 啟動 Dashcam Web App(Node.js 版)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# (選用)若把資料放在獨立掛載碟,設定 DASHCAM_DATA_MOUNT 讓啟動前檢查它是否已掛載;
# 未設定時略過(預設資料目錄為專案下的 ./data,見 DASHCAM_DATA_DIR)。
if [ -n "${DASHCAM_DATA_MOUNT:-}" ] && ! mountpoint -q "$DASHCAM_DATA_MOUNT"; then
  echo "警告:$DASHCAM_DATA_MOUNT 未掛載,影片儲存可能失敗"
fi

# 確認已建置
if [ ! -f "$SCRIPT_DIR/dist/server.js" ]; then
  echo "尚未建置,執行 npm run build…"
  npm run build
fi

exec node --env-file-if-exists=.env dist/server.js
