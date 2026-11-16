#!/usr/bin/env bash
set -euo pipefail

# Local installer / patcher / restorer for T3 Code Simplified Chinese (zh-CN) on Linux AppImage.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE_PATH="${T3CODE_APPIMAGE:-$HOME/.local/share/t3code/T3-Code.AppImage}"
BACKUP_PATH="${APPIMAGE_PATH}.orig"
OWNER="${T3CODE_ZH_OWNER:-Mason-x}"
REPO="${T3CODE_ZH_REPO:-t3code}"

cmd="${1:-patch}"

case "$cmd" in
  patch)
    if [[ ! -f "$APPIMAGE_PATH" ]]; then
      echo "Error: AppImage not found at $APPIMAGE_PATH" >&2
      exit 1
    fi
    if [[ ! -f "$BACKUP_PATH" ]]; then
      cp -a "$APPIMAGE_PATH" "$BACKUP_PATH"
      echo "Backed up original AppImage to $BACKUP_PATH"
    else
      echo "Using existing backup at $BACKUP_PATH as clean input"
    fi
    "$SCRIPT_DIR/repack-appimage.sh" \
      --input "$BACKUP_PATH" \
      --output "$APPIMAGE_PATH" \
      --owner "$OWNER" \
      --repo "$REPO"
    echo "Done! Restart T3 Code to load the Simplified Chinese UI and Mason-x/t3code update feed."
    ;;
  restore)
    if [[ ! -f "$BACKUP_PATH" ]]; then
      echo "Error: Backup not found at $BACKUP_PATH" >&2
      exit 1
    fi
    cp -a "$BACKUP_PATH" "$APPIMAGE_PATH.tmp"
    chmod +x "$APPIMAGE_PATH.tmp"
    mv -f "$APPIMAGE_PATH.tmp" "$APPIMAGE_PATH"
    echo "Restored original AppImage from $BACKUP_PATH. Restart T3 Code."
    ;;
  download)
    TAG="${2:-latest}"
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64|amd64) PATTERN="*x86_64.AppImage" ;;
      aarch64|arm64) PATTERN="*arm64.AppImage" ;;
      *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
    esac
    if [[ "$TAG" == "latest" ]]; then
      gh release download -R "$OWNER/$REPO" --pattern "$PATTERN" --dir "$TMP_DIR"
    else
      gh release download "$TAG" -R "$OWNER/$REPO" --pattern "$PATTERN" --dir "$TMP_DIR"
    fi
    DOWNLOADED="$(ls "$TMP_DIR"/*.AppImage | head -n 1)"
    mkdir -p "$(dirname "$APPIMAGE_PATH")"
    if [[ -f "$APPIMAGE_PATH" && ! -f "$BACKUP_PATH" ]]; then
      cp -a "$APPIMAGE_PATH" "$BACKUP_PATH"
      echo "Backed up previous AppImage to $BACKUP_PATH"
    fi
    chmod +x "$DOWNLOADED"
    mv -f "$DOWNLOADED" "$APPIMAGE_PATH"
    echo "Installed patched AppImage from $OWNER/$REPO ($TAG) to $APPIMAGE_PATH"
    ;;
  *)
    cat <<'EOF'
Usage: install-local.sh [patch|restore|download [tag]]
  patch             Backup ~/.local/share/t3code/T3-Code.AppImage and apply zh-CN patch locally (default)
  restore           Restore ~/.local/share/t3code/T3-Code.AppImage from .orig backup
  download [tag]    Download pre-built zh-CN AppImage from Mason-x/t3code Releases
EOF
    exit 1
    ;;
esac
