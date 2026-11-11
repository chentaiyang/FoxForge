# 灵狐工坊 · FoxForge

本地全能格式转换桌面客户端。中文名 **灵狐工坊**，英文名 **FoxForge**，吉祥物叫 **灵灵**。

用 Electron + React + TypeScript + Vite 开发，转换全部在你这台电脑上完成，不把文件交到云端。完整引擎只做桌面端；以后网页版会砍掉重功能，iOS 也会再单独做。

当前版本 **0.1.1**。内部 npm 包名仍是 `mediaforge`，`appId` 是 `com.mediaforge.app`，预加载桥是 `window.mediaForge`。改产品名时不要随便改这些内部标识。

> **不内置**网易云 NCM、QQ 音乐 mgg/mflac、酷狗 KGM 等加密音乐格式的解密。

---

## 目录

- [功能](#功能)
- [如何使用](#如何使用)
- [二次开发](#二次开发)
- [环境要求](#环境要求)
- [命令一览](#命令一览)
- [引擎总表](#引擎总表)
- [目录结构](#目录结构)
- [打包](#打包)
- [合法使用](#合法使用)
- [路线图](#路线图)

---

## 功能

### 格式转换

工作台支持拖放、点击投放区选文件、右上角「选择文件夹」整夹导入。识别来源类型后给出可转目标，可批量排队。

| 类型 | 能做什么 |
|------|----------|
| 普通音视频 | 本机 FFmpeg。音频：mp3 / wav / flac / aac / m4a / ogg / opus / wma 等；视频：mp4 / mkv / webm / mov / gif。编码可选 H.264 / H.265 / AV1，或流复制 `copy`。 |
| Office / WPS | 本机 LibreOffice 无界面转换。doc / docx / odt / rtf、xls / xlsx / et、ppt / pptx / dps 等，可转到 PDF、DOCX 等。 |
| PDF | 转 PNG / JPG（Poppler）、WebP（Poppler + Sharp）、TXT（文本层）。转到 DOCX / HTML / XLSX 等走 LibreOffice。合并、按页拆分用 pdf-lib。AES-256 加密 / 解密用 qpdf。多个加密 PDF 可勾选「其他加密 PDF 都使用此密码」。扫描件可走 OCR。 |
| 图片 | Sharp 互转 jpg / png / webp / gif / tiff / avif。HEIC/HEIF 优先 Sharp，失败再 FFmpeg。BMP / ICO / TGA / 视频静帧走 FFmpeg（ICO 限制单尺寸 256×256）。多图可合成 PDF。图片也可 OCR 成 TXT / MD / DOCX。RAW（含 CR3，优先 LibRaw `dcraw_emu`）、PSD、AI、JP2、JXL、QOI 有对应路径或明确报错，不会假装成功。 |
| 电子书 | Pandoc：txt / md / html ↔ epub，以及 epub → txt / md / html。有 LibreOffice 时还可转到 PDF / DOCX。MOBI 可走内置解包；AZW3 以及更好的 MOBI 转换走 Calibre（`ebook-convert`，Windows 安装包已内置）。 |
| 字幕 | 字幕格式转换（见 `electron/engines/subtitle.ts`）。 |
| 压缩包 | ZIP 等归档转换（见 `electron/engines/archive.ts`）。 |

### 人声分离

侧边栏单独一页。优先 **Demucs**（人声+伴奏或四轨），其次 **UVR · MDX-Net**（本机 ONNX，CPU）。两者都不可用时，可退回 **FFmpeg 简易分离**（中心/侧声道近似，界面会标明质量远不如 Demucs）。UVR 的 VR Architecture 尚未接入。

### 任务队列

- 标题栏右侧有进度圆（像网盘传输标记），点开或悬停可看任务列表。
- 主页面和弹层都可以暂停、取消。
- Windows 没有可靠的进程暂停信号：暂停表示**不再启动下一项**，当前这一项可能会跑完；取消仍可结束进程。
- 打包、写盘收尾视为原子操作：先写完、校验，若已点取消再删掉输出，避免留下半截文件。
- 导出前会预估大小并在磁盘上预占空间（旁路 `.space` 文件，不和引擎输出抢同一路径）。空间不够会报 `E-DISK-SPACE`，并说明还差多少。
- 失败时先给可能原因，再提供「查看详情」；错误码有对应中文说明。
- 可设置并发数（1 / 2 / 4 / 8，或 0 自动：`min(8, max(2, 逻辑核心数-1))`）。LibreOffice 和图片引擎内部仍然串行，避免把共享配置或 libvips 打崩。FFmpeg 等可以并行。

### 界面与设置

- 无框窗口，侧边栏是窄的图标按钮，鼠标移上去再弹出说明。
- 标题栏左侧是产品名和灵灵头像；右侧是引擎状态（就绪数 / 总数）和任务进度圆。鼠标移到引擎状态上会弹出各引擎详情。
- 「特殊音乐模块」永远是可选、不会变成就绪，但仍计入分母，所以常见显示是 **9/10**，这不是引擎坏了。
- 主题：跟随系统、浅色、深色。
- **高级渲染**：标签就叫「高级渲染」，右侧下拉「开启 / 关闭」，不要写成「关闭高级渲染」。关掉后会减弱模糊、动画，方便低配电脑。改完并写入本地设置后，右上角才会弹出提示。
- 成功 / 失败提示是右上角的**绿框（或红框）白字**卡片：左侧对勾或感叹号，右侧关闭，底部有一条从右往左收的倒计时。时间到了会渐隐。多条竖着叠放，文字太长会换行。

---

## 如何使用

### 安装包

Windows 安装包发布在 [GitHub Releases](https://github.com/chentaiyang/FoxForge/releases)。下载 `FoxForge-*-Setup.exe` 后按向导安装（可改安装目录，也可选择仅为当前用户或为所有用户安装）。

从 v0.1.1 起，Windows 安装包**已内置全部转换引擎**（FFmpeg、LibreOffice、Poppler、qpdf、Tesseract、Pandoc、LibRaw、Calibre、Demucs / UVR 等），安装后即可使用，不必再单独安装这些工具。系统 PATH 里已有的同名工具仅作为后备。开发时从源码运行，仍可用系统已装的工具，或自行放到 `resources/` 对应目录。安装包尚未做代码签名，Windows 可能弹出 SmartScreen 提示，选择「仍要运行」即可。

### 开发时直接跑

需要已安装 Node.js（推荐 20，系统里还要有一份真正的 Node，Sharp 不能走 Electron 自带的运行时，见下文）。

```bash
git clone <本仓库地址>
cd FoxForge          # 或你的本地目录名
npm install
npm run dev
```

若 Sharp 的原生模块没装好：

```bash
npm install-scripts approve sharp
npm rebuild sharp
```

若使用 Windows 安装包，引擎已随包装好，打开后可在设置页确认是否就绪。若从源码开发，请按「环境要求」安装或下载这些工具。

### 转换文件

1. 打开「格式转换」。
2. 把文件拖进投放区，或**点击投放区中间**选择文件。要整夹导入时，点投放区右上角的「选择文件夹」。空投放区会显示灵灵；有文件后改回向上箭头。
3. 确认识别出的类型和目标格式。PDF 若有密码，在对应位置填写；多个加密 PDF 可勾选共用同一密码。
4. 需要的话，看一下预计大小，并在设置里调整并发。
5. 开始转换。进度会出现在本页，同时标题栏右侧的圆也会动。
6. 完成后可以打开输出目录。失败时先看简短原因，再点「查看详情」。

暂停和取消在主页面和右上角任务弹层里都可以操作。取消已经开始打包的任务时，程序会先让写入走完，再检查并删除，避免半截文件报错。

### 人声分离

1. 打开侧边栏「人声分离」，导入音频。
2. 可选输出目录，选择 Demucs 或已就绪的 UVR · MDX-Net。
3. 开始分离。没有 Demucs / UVR 时，会看到安装说明，或只能使用质量较差的 FFmpeg 简易分离，不会假装成功。

安装 Demucs（项目内 CPU 虚拟环境）：

```bash
node scripts/ensure-demucs.mjs --install
```

UVR 模型：

```bash
node scripts/ensure-uvr.mjs
```

也可用环境变量 `MEDIAFORGE_DEMUCS_PYTHON`、`MEDIAFORGE_UVR_MODEL_DIR` 指向自己的解释器和模型目录。

### 看引擎、改设置

- 标题栏引擎指示灯：鼠标移上去查看每一项是否就绪。点设置里的探测，可以再扫一遍本机工具。
- 设置里可改主题、语言、高级渲染、转换并发。每一项都是**写入并生效之后**才弹出「设置成功」。
- 本机设置存在 Electron 的 userData 目录里（Linux 上是 `~/.config/灵狐工坊`）。改过 `productName` 后这是一个新目录，旧配置不会自动跟过来。

### 自测建议

设置页看到对应引擎为「就绪」后，可用 `test-fixtures/` 里的示例：

- 图片 / 多图 PDF：`sample.png`、`sample2.png`
- OCR：`ocr-hello.png`、`ocr-hello.pdf`
- 电子书：`ebook-hello.md`（若还没有，跑一次 `npm run smoke:ebook` 会生成）
- RAW：`sample.cr3`（请用仓库里这份完整样张，不要用残缺的测试文件）

也可以直接跑文末的冒烟命令。缺工具时转换必须给出清楚的中文错误，不能静默失败。

---

## 二次开发

欢迎在本仓库上改功能、加格式、调界面。下面是动手前应该知道的约定。源码注释是简体中文，重点写「为什么这么写」和陷阱，请一起维护。

### 技术架构

```
渲染进程 (React，src/)
    ↓ window.mediaForge（preload 暴露的 API）
预加载 (electron/preload.ts)
    ↓ IPC
主进程 (electron/main.ts)
    ↓ 各引擎 + jobs.runWithJob
FFmpeg / LibreOffice / Poppler / qpdf / Sharp 工作进程 / Demucs / UVR ...
```

- 界面和主题在渲染进程。
- 真正读文件、调外部工具、占磁盘，都在主进程和它拉起的子进程里。
- **Sharp 绝不能在 Electron 进程里跑真实的 libvips 操作**，否则会直接崩溃。必须用系统 Node 启动 `resources/bin/sharp-worker.mjs`，并且不能用 `process.execPath`（那是 Electron），也不能靠 `ELECTRON_RUN_AS_NODE` 伪装。判断条件是 `Boolean(process.versions.electron)`。纯 Node 冒烟可以在进程内 `require('sharp')`，但产品路径在 Electron 里一律走工作进程。`vite.config.ts` 里已把 `sharp` 设为 external。

### 目录怎么分工

| 路径 | 职责 |
|------|------|
| `electron/main.ts` | 窗口、IPC 入口 |
| `electron/preload.ts` | 把 `MediaForgeAPI` 挂到 `window.mediaForge` |
| `electron/engines/jobs.ts` | 任务生命周期、暂停/取消、磁盘预占、并发限制 |
| `electron/engines/*.ts` | 各转换引擎 |
| `electron/engines/bins.ts` | 查找系统或 `resources/bin` 里的工具 |
| `resources/bin/sharp-worker.mjs` | 隔离的 Sharp 工作进程 |
| `src/pages/` | 转换、人声、设置、更多 |
| `src/components/` | 标题栏、侧边栏、引擎状态、任务圆、失败说明 |
| `src/hooks/` | 设置、Toast、任务会话、引擎健康、浮层定位 |
| `src/data/capabilities.ts` | 格式分组、目标格式、体积估算 |
| `src/data/errorCatalog.ts` | 错误码 → 给人看的原因 |
| `src/styles/global.css` | 全局样式与主题变量 |
| `scripts/ensure-*.mjs` | 探测或安装本机引擎 |
| `scripts/smoke-*.mjs` | 冒烟测试 |
| `brand/`、`build/`、`public/` | 图标与灵灵原图、安装包图标、界面用图 |
| `test-fixtures/` | 测试样张 |

### 怎样加一种新格式或新引擎

1. 在对应的 `electron/engines/` 文件里实现转换，返回统一的 `ConvertResult`，进度走 `ConvertProgressEvent`。
2. 用 `jobs.runWithJob`、`preflightOutput` / `reserveOrFail` 包起来，让暂停、取消和预占磁盘生效。Office 类用 `limitOffice`，图片类用 `limitImage`。
3. 在 `getEngineHealth()` 能汇总到的地方提供健康探测（就绪 / 缺失 / 可选），写清缺什么、怎么装。
4. 在 `preload.ts` 和 `main.ts` 登记 IPC，类型放进 `MediaForgeAPI`。
5. 在 `src/data/capabilities.ts` 里补上来源分组和可转目标，转换页才能选到。
6. 把失败映射到 `errorCatalog.ts`，给短文案和详情。
7. 加 `scripts/smoke-xxx.mjs`（以及需要时的 `ensure-xxx.mjs`），用 `test-fixtures` 里的真实文件验证。
8. 补中文注释：文件头说明职责和约束，导出函数写简短 JSDoc。

不要为了「分母好看」去改「特殊音乐模块」的计数，除非产品上明确要求改这一条。

### 界面和交互上的坑

- 标题栏、步骤条用了 `backdrop-filter`，会形成新的层叠上下文。任务列表、引擎状态这些浮层必须 `createPortal(..., document.body)`，再用 `useAnchoredPosition` 做 `position: fixed`（z-index 400），否则会被挡住。
- Toast 用 `useToast().success()` / `error()`。设置项必须先写入 `mediaforge-settings` 并应用到 DOM，再提示成功。
- 主题写在 `document.documentElement` 的 `data-theme` 和 `data-effects` 上。关高级渲染时，不要依赖模糊和进场动画。
- 侧边栏、投放区、标题栏的品牌文案对外用「灵狐工坊 / FoxForge / 灵灵」，不要把内部包名摊到界面上。

### 注释和内部标识

- 注释用简体中文，写原因和限制，不要给每一行复述代码。
- 可以改界面文案和 `productName`，但默认不要改：`package.json` 的 `name`（`mediaforge`）、`appId`、`window.mediaForge` / `MediaForgeAPI`、`localStorage` 键 `mediaforge-settings`、环境变量前缀 `MEDIAFORGE_*`。
- 改 `productName` 会换一套 Electron userData 目录，等于一次全新的本机配置。

### 建议的开发节奏

```bash
npm run dev          # 开发，改渲染进程通常会热更新
npm run typecheck    # 提交前至少跑这个
npm run smoke:image  # 以及你改到的那一类 smoke
```

在 Electron 里验证 Sharp 时，请用 `scripts/electron-sharp-retest.mjs` 这类真正拉起 Electron 的脚本，不要只用 Node 里 `require('sharp')` 的结果当结论。

---

## 环境要求

- Node.js 18+（推荐 20；主机上需要「系统 Node」，供 Sharp 工作进程使用）
- 开发可在 Windows 10/11、Linux、macOS 上进行；目标发行平台以 Windows 桌面为主
- 本机工具（在 PATH 或 `resources/bin` 中即可）：

| 工具 | 用途 | 常见安装方式 |
|------|------|----------------|
| FFmpeg + ffprobe | 音视频、部分图片 | Windows 安装包已内置；开发时可放到 `resources/bin` 或用系统包 |
| LibreOffice（`soffice`） | Office / 部分电子书出 PDF、DOCX | Windows 安装包已内置到 `resources/LibreOffice`；Linux 可系统安装 |
| Poppler（`pdftoppm`、`pdftotext`） | PDF 栅格化和文本提取 | Windows 安装包已内置；Linux：`sudo apt install poppler-utils` |
| qpdf | PDF 加密解密 | Windows 安装包已内置；Linux：`sudo apt install qpdf` 或 `node scripts/ensure-pdf-tools.mjs --install-qpdf` |
| Sharp | 图片 | `npm install`（需允许原生脚本）；安装包会解出 asar 中的原生模块 |
| Tesseract + `chi_sim` + `eng` | OCR | Windows 安装包已内置语言包；开发见 `node scripts/ensure-tesseract.mjs` |
| Pandoc | 电子书 | Windows 安装包已内置；开发可用 `node scripts/ensure-pandoc.mjs --install` |
| LibRaw（`dcraw_emu`） | CR3 等新 RAW | Windows 安装包已内置；开发可用 `node scripts/ensure-image-extras.mjs --install` |
| Demucs | 人声分离 | Windows 安装包已内置 CPU 环境；开发可用 `node scripts/ensure-demucs.mjs --install` |
| UVR 模型 | MDX-Net 分离 | Windows 安装包已内置默认 ONNX 模型；开发可用 `node scripts/ensure-uvr.mjs` |
| Calibre | AZW3 / 更好的 MOBI | Windows 安装包已内置；开发可用 `node scripts/ensure-calibre.mjs --install` |

Windows 安装包由 `scripts/ensure-windows-engines.mjs` 在 CI 里下载官方或常用的 x64 构建，再经 electron-builder `extraResources` 放进安装包（引擎在 asar 之外）。这些大二进制不进 git。Sharp 随 Node 依赖分发，打包时会 asarUnpack 原生模块。系统 PATH 中的同名工具仅作为后备。

---

## 命令一览

```bash
npm run dev
npm run typecheck
npm run build
npm run dist:win          # 打 Windows NSIS 安装包（在 Windows 上；发布前先跑 ensure:windows-engines）
node scripts/ensure-windows-engines.mjs --install  # 下载并布置全部 Windows 引擎

# 探测 / 安装引擎
node scripts/ensure-libreoffice.mjs [--install]
node scripts/ensure-pdf-tools.mjs [--install-qpdf] [--apt]
node scripts/ensure-tesseract.mjs [--apt] [--install-debs]
node scripts/ensure-pandoc.mjs [--install]
node scripts/ensure-image-extras.mjs [--install]
node scripts/ensure-demucs.mjs [--install]
node scripts/ensure-uvr.mjs
node scripts/ensure-calibre.mjs [--install]

# 冒烟
npm run smoke:ffmpeg
npm run smoke:libreoffice
npm run smoke:pdf
npm run smoke:image
npm run smoke:image-extras
npm run smoke:ocr
npm run smoke:ebook
npm run smoke:archive
npm run smoke:subtitle
npm run smoke:vocal
MEDIAFORGE_SMOKE_DEMUCS=1 npm run smoke:vocal   # 真跑 Demucs，会下载权重，较慢
```

也可用 `npm run ensure:*`、`npm run smoke:*` 的简写（见 `package.json` 的 `scripts`）。

---

## 引擎总表

| 引擎 | 状态 | 覆盖 |
|------|------|------|
| FFmpeg | 已接入 | 普通音视频；部分图片；人声简易降级 |
| LibreOffice | 已接入 | Office / WPS；电子书和 OCR 出 DOCX / PDF |
| Poppler | 已接入 | PDF → 图 / 文本；扫描 PDF OCR 前处理 |
| qpdf | 已接入 | PDF 加密 / 解密 |
| pdf-lib | 已接入 | PDF 合并 / 拆分；多图 → PDF |
| Sharp | 已接入（Electron 内走系统 Node 工作进程） | 图片互转；PDF → WebP 后半段 |
| Tesseract | 已接入 | 图片 / 扫描 PDF OCR → TXT / MD / DOCX |
| Pandoc | 已接入 | 电子书互转；配合 LibreOffice 出 PDF / DOCX |
| LibRaw / dcraw_emu | 已接入（经典 dcraw 不解 CR3） | RAW，含 CR3 |
| Demucs | 已接入（可选） | 人声 / 伴奏 / 四轨 |
| UVR · MDX-Net | 已接入（可选，CPU） | 人声分离备选 |
| UVR · VR Architecture | 未接入 | 选中时会明确说明 |
| 字幕 / 压缩包 | 已接入 | 见对应引擎文件 |
| 特殊音乐模块 | 永远可选，不就绪 | 需外部合法工具；应用内不破解。会计入引擎总数分母 |

---

## 目录结构

```
├── electron/                 主进程、预加载、引擎
│   ├── main.ts
│   ├── preload.ts
│   └── engines/
├── src/                      渲染进程界面
│   ├── pages/
│   ├── components/
│   ├── hooks/
│   ├── data/
│   └── styles/global.css
├── resources/bin/            可随包分发的工具（大文件默认不进 Git）
│   └── sharp-worker.mjs
├── scripts/                  安装引擎、冒烟、Electron 专项复测
├── test-fixtures/            测试样张
├── brand/                    图标与灵灵源图
├── build/                    安装包图标
├── public/                   窗口图标、界面用的灵灵图
├── package.json
└── vite.config.ts
```

`.gitignore` 会排除 `node_modules`、构建产物，以及 LibreOffice、Calibre、便携 Python、UVR 模型、本地 FFmpeg / Pandoc 等大二进制。克隆源码后，Linux / macOS 开发机用 `ensure-*` 脚本或系统包补齐引擎；打 Windows 安装包时由 `ensure-windows-engines.mjs` 在 CI 下载，不必提交这些文件。

---

## 打包

Windows 安装包目标是 NSIS。当前配置为：

- `oneClick: false`（辅助安装向导，不是一键装完）
- `allowToChangeInstallationDirectory: true`（可改安装目录）

因此向导里会出现「为谁安装」页：仅为当前用户，或为这台电脑的所有用户（后者通常要管理员权限）。

在能打 Windows 包的环境上执行：

```bash
npm run dist:win
```

输出在 `release/`。开发阶段不必急着打包；源码和 `npm run dev` 即可日常开发。

---

## 合法使用

请只转换你有权处理的文件。

特殊加密音乐：若你使用外部合法工具处理自己有权使用的文件，那是你自己的选择。本项目**不内置、不编译、不提供**破解 DRM、绕过付费或传播未授权内容的实现与说明。

---

## 路线图

- 人声页导入后的专业波形与排版
- 完善 RAW / CR3 的安装与冒烟脚本
- 已完成：Windows 安装包内置全部转换引擎（见 v0.1.1）
- 可选的 UVR VR 架构、Demucs GPU / DirectML 探测
- 轻量网页版（砍掉重引擎）与 iOS 版

问题和改进建议可以直接开 Issue 或 Pull Request。改功能时请顺手补测试和中文注释。
