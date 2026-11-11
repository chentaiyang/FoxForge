# Bundled binaries（计划 / 开发）

Windows 打包时把以下文件放在本目录，electron-builder 会拷到 `resources/bin/`：

- `ffmpeg.exe` / `ffprobe.exe`
- Poppler：`pdftoppm.exe` / `pdftotext.exe`（及依赖 DLL）
- qpdf：可直接放 `qpdf.exe`，或整个 `qpdf-toolkit/`（`bin/` + `lib/`）
- （可选）LibreOffice 便携版入口；体积很大，也可要求用户安装系统 LibreOffice
- Pandoc：`pandoc` / `pandoc.exe`（`node scripts/ensure-pandoc.mjs --install`）

开发机也可把同名二进制放这里（Linux/macOS 用无扩展名），应用会优先于系统 PATH 使用。

便携 qpdf 可用：

```bash
node scripts/ensure-pdf-tools.mjs --install-qpdf
```

当前仓库默认不提交大型二进制；`qpdf-toolkit/` 已在 `.gitignore`。

- RAW：`dcraw` / `dcraw.exe`（`node scripts/ensure-image-extras.mjs --install`）
- 可选 Calibre：`ebook-convert` 或整个 `resources/calibre/`（`node scripts/ensure-calibre.mjs --install`）
- UVR 模型在 `resources/uvr-models/`（`node scripts/ensure-uvr.mjs`）
