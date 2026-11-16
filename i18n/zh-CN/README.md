# T3 Code 简体中文补丁与自动跟踪上游方案

本目录用于为 T3 Code Linux AppImage 注入**简体中文界面补丁**，并将桌面端自动更新源（`resources/app-update.yml`）指向 `Mason-x/t3code`，实现：
- 上游 `pingdotgg/t3code` 发布新版本时，GitHub Actions 自动拉取官方 `AppImage`、打入中文补丁并发布到本 Fork 的 Releases；
- 本地安装本 Fork 构建的 AppImage 后，应用内自动更新会直接拉取本 Fork 的中文版本，不会被官方英文版覆盖；
- 常用开发术语保留英文（如 `Worktree`、`Thread`、`Provider`、`MCP`、`Skill`、`Checkpoint`、`Git`、`PR`、`Diff`、`Commit`、`Branch`、`SSH`、`URL`、`API key` 等）。

## 文件说明

- `dict.json`：简体中文词典（`exact` 精确字面量映射 + `patterns` 前缀规则）。
- `patch-asar.mjs`：纯 Node.js 补丁脚本，采用 JS 词法扫描安全替换 UI 字符串（避开对象属性键、`===`/`!==`/`case` 比较及第三方语法高亮/字体等资源块），同时更新 `index.html`、`app-update.yml` 及 `RELEASES_URL`，并重算 `app.asar` SHA-256 完整性校验信息。
- `repack-appimage.sh`：无 FUSE 依赖的 Type-2 AppImage 解包/重打包脚本（同时生成 `electron-updater` 所需的 `latest-linux.yml` / `nightly-linux.yml`）。
- `install-local.sh`：本机一键应用补丁、还原备份或从 Fork Releases 下载安装。
- `../../.github/workflows/zh-cn-release.yml`：每 6 小时自动同步上游并检查新 Release，自动打包发布中文版到 `Mason-x/t3code` Releases。

## 本机使用

```bash
# 1. 对本机 ~/.local/share/t3code/T3-Code.AppImage 备份并打入简体中文补丁
./i18n/zh-CN/install-local.sh patch

# 2. 还原回官方原版（从 .orig 备份恢复）
./i18n/zh-CN/install-local.sh restore

# 3. 或者直接从 Mason-x/t3code Releases 下载已打包好的中文版
./i18n/zh-CN/install-local.sh download
```

## 补充翻译词条

只需编辑 `i18n/zh-CN/dict.json` 并推送到 `main`，然后在 GitHub Actions 中手动运行 **Sync Upstream & Build zh-CN Release**（勾选 `force: true`）即可重新发布当前版本。
