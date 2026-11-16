#!/usr/bin/env bash
set -euo pipefail

# Repack a T3 Code Type-2 AppImage with Simplified Chinese (zh-CN) UI patches
# and redirect electron-updater feed to the forked GitHub repository.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT=""
OUTPUT=""
OWNER="${T3CODE_ZH_OWNER:-Mason-x}"
REPO="${T3CODE_ZH_REPO:-t3code}"
DICT="${SCRIPT_DIR}/dict.json"
YML_OUT=""
VERSION=""
ASSET_URL=""
RELEASE_DATE=""

usage() {
  cat <<'EOF'
Usage: repack-appimage.sh --input <in.AppImage> --output <out.AppImage> [options]

Options:
  --input <path>         Input upstream T3-Code AppImage (required)
  --output <path>        Output patched AppImage path (required)
  --owner <owner>        GitHub owner for auto-updater (default: Mason-x)
  --repo <repo>          GitHub repo for auto-updater (default: t3code)
  --dict <path>          Translation dictionary JSON (default: ./dict.json)
  --yml-out <path>       Optional path to write electron-updater feed YAML (e.g. latest-linux.yml)
  --version <ver>        Version string for feed YAML (auto-detected from app.asar package.json if omitted)
  --asset-url <url>      Asset filename in feed YAML (default: basename of --output)
  --release-date <iso>   ISO timestamp for feed YAML (default: current UTC time)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --dict) DICT="$2"; shift 2 ;;
    --yml-out) YML_OUT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --asset-url) ASSET_URL="$2"; shift 2 ;;
    --release-date) RELEASE_DATE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$INPUT" || -z "$OUTPUT" ]]; then
  echo "Error: --input and --output are required." >&2
  usage
  exit 1
fi

for cmd in unsquashfs mksquashfs node python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found in PATH." >&2
    exit 1
  fi
done

INPUT="$(realpath "$INPUT")"
mkdir -p "$(dirname "$OUTPUT")"
OUTPUT_ABS="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Locate SquashFS superblock offset reliably (works cross-arch and without FUSE)
OFFSET="$(python3 - "$INPUT" <<'PY'
import os, struct, sys

path = sys.argv[1]
size = os.path.getsize(path)
with open(path, "rb") as f:
    # AppImage Type 2 runtime is typically < 4 MiB
    head = f.read(min(size, 8 * 1024 * 1024))

pos = 0
while True:
    idx = head.find(b"hsqs", pos)
    if idx == -1:
        break
    if idx + 96 <= len(head):
        magic, inodes, mkfs_time, block_size, frag_count, comp_id, block_log, flags, no_ids, s_major, s_minor, root_inode, bytes_used = struct.unpack_from("<IIIIIHHHHHHQQ", head, idx)
        # Validate SquashFS 4.0 superblock fields
        if (
            magic == 0x73717368
            and s_major == 4
            and s_minor == 0
            and block_size in (4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576)
            and (1 << block_log) == block_size
            and 0 < bytes_used <= (size - idx)
        ):
            print(idx)
            sys.exit(0)
    pos = idx + 4

sys.exit(1)
PY
)"

if [[ -z "$OFFSET" ]]; then
  echo "Error: could not find valid SquashFS superblock in $INPUT" >&2
  exit 1
fi

echo "Found SquashFS offset: $OFFSET"
head -c "$OFFSET" "$INPUT" > "$WORK/runtime.bin"

unsquashfs -q -no-progress -o "$OFFSET" -d "$WORK/squashfs-root" "$INPUT"

node "$SCRIPT_DIR/patch-asar.mjs" \
  --resources-dir "$WORK/squashfs-root/resources" \
  --dict "$DICT" \
  --owner "$OWNER" \
  --repo "$REPO"

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -e '
    const fs = require("fs");
    const buf = fs.readFileSync(process.argv[1]);
    const jsonLen = buf.readUInt32LE(12);
    const tree = JSON.parse(buf.subarray(16, 16 + jsonLen).toString("utf8"));
    const meta = tree.files["package.json"];
    const dataStart = 8 + buf.readUInt32LE(4);
    const pkg = JSON.parse(buf.subarray(dataStart + Number(meta.offset), dataStart + Number(meta.offset) + meta.size).toString("utf8"));
    process.stdout.write(pkg.version);
  ' "$WORK/squashfs-root/resources/app.asar")"
fi

mksquashfs "$WORK/squashfs-root" "$WORK/payload.sqfs" \
  -root-owned -noappend -comp zstd -b 131072 -quiet

cat "$WORK/runtime.bin" "$WORK/payload.sqfs" > "$OUTPUT_ABS.tmp"
chmod +x "$OUTPUT_ABS.tmp"
mv -f "$OUTPUT_ABS.tmp" "$OUTPUT_ABS"
echo "Built patched AppImage: $OUTPUT_ABS (version: $VERSION)"

if [[ -n "$YML_OUT" ]]; then
  mkdir -p "$(dirname "$YML_OUT")"
  if [[ -z "$ASSET_URL" ]]; then
    ASSET_URL="$(basename "$OUTPUT_ABS")"
  fi
  if [[ -z "$RELEASE_DATE" ]]; then
    RELEASE_DATE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  fi
  python3 - "$OUTPUT_ABS" "$YML_OUT" "$VERSION" "$ASSET_URL" "$RELEASE_DATE" <<'PY'
import base64, hashlib, os, sys

appimage_path, yml_out, version, asset_url, release_date = sys.argv[1:6]
size = os.path.getsize(appimage_path)
h = hashlib.sha512()
with open(appimage_path, "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
sha512_b64 = base64.b64encode(h.digest()).decode("ascii")

content = (
    f"version: {version}\n"
    f"files:\n"
    f"  - url: {asset_url}\n"
    f"    sha512: {sha512_b64}\n"
    f"    size: {size}\n"
    f"path: {asset_url}\n"
    f"sha512: {sha512_b64}\n"
    f"releaseDate: '{release_date}'\n"
)
with open(yml_out, "w", encoding="utf-8") as f:
    f.write(content)
print(f"Wrote feed manifest: {yml_out} (size={size}, sha512={sha512_b64[:16]}...)")
PY
fi
