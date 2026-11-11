/**
 * 把引擎错误码和关键词映射成界面上的「可能原因」和操作提示。
 * 磁盘不足统一为 E-DISK-SPACE（主进程在预估用量之外还会预留 80MB 头部空间）。
 */
export interface ErrorCatalogEntry {
  code: string
  reason: string
  hint?: string
}

export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  'E-FFMPEG-MISSING': {
    code: 'E-FFMPEG-MISSING',
    reason: '未检测到 FFmpeg',
    hint: '请安装 ffmpeg 并加入 PATH，或放入 resources/bin 后重启。',
  },
  'E-FFMPEG-FAILED': {
    code: 'E-FFMPEG-FAILED',
    reason: 'FFmpeg 转换失败',
    hint: '请确认源文件完好，或更换编码/格式后重试。详情里是引擎原始输出。',
  },
  'E-LO-MISSING': {
    code: 'E-LO-MISSING',
    reason: '未检测到 LibreOffice',
    hint: '请安装 LibreOffice（soffice）并加入 PATH，或放入 resources/bin。开发机可运行 node scripts/ensure-libreoffice.mjs。',
  },
  'E-LO-FAILED': {
    code: 'E-LO-FAILED',
    reason: 'LibreOffice 文档转换失败',
    hint: '请确认文档未损坏、未加密，或换一种目标格式再试。',
  },
  'E-PDF-PASSWORD': {
    code: 'E-PDF-PASSWORD',
    reason: 'PDF 加密或解密缺少密码，或密码不正确',
    hint: '请填写正确的密码后再试。',
  },
  'E-PDF-MERGE-MIN': {
    code: 'E-PDF-MERGE-MIN',
    reason: '合并 PDF 至少需要 2 个文件',
    hint: '请把要合并的 PDF 都加入队列。',
  },
  'E-PDF-POPPLER': {
    code: 'E-PDF-POPPLER',
    reason: '未检测到 Poppler（pdftoppm / pdftotext）',
    hint: '请安装 poppler-utils，或放入 resources/bin。',
  },
  'E-PDF-QPDF': {
    code: 'E-PDF-QPDF',
    reason: '未检测到 qpdf，或 qpdf 处理失败',
    hint: '加密/解密需要 qpdf。请安装并加入 PATH，或放入 resources/bin。',
  },
  'E-PDF-FAILED': {
    code: 'E-PDF-FAILED',
    reason: 'PDF 处理失败',
    hint: '文件可能已损坏、已加密，或目标格式不受支持。',
  },
  'E-IMAGE-SHARP': {
    code: 'E-IMAGE-SHARP',
    reason: '未检测到 Sharp 图片引擎',
    hint: '请执行 npm install sharp（需允许 install scripts）后重启。',
  },
  'E-IMAGE-FAILED': {
    code: 'E-IMAGE-FAILED',
    reason: '图片转换失败',
    hint: '请确认源图完好；部分格式需要额外解码器。',
  },
  'E-RAW-DECODE': {
    code: 'E-RAW-DECODE',
    reason: 'RAW 照片解码失败',
    hint: '请确认已放入 dcraw_emu / LibRaw，且照片未损坏。',
  },
  'E-OCR-MISSING': {
    code: 'E-OCR-MISSING',
    reason: '未检测到 Tesseract OCR 或缺少语言包',
    hint: '请安装 tesseract-ocr 以及 chi_sim / eng 语言包，或运行 node scripts/ensure-tesseract.mjs。',
  },
  'E-OCR-FAILED': {
    code: 'E-OCR-FAILED',
    reason: 'OCR 识别失败',
    hint: '请确认图像或扫描件清晰，并已安装对应语言包。',
  },
  'E-EBOOK-PANDOC': {
    code: 'E-EBOOK-PANDOC',
    reason: '未检测到 Pandoc，或电子书转换失败',
    hint: '请安装 Pandoc 并加入 PATH，或放入 resources/bin。开发机可运行 node scripts/ensure-pandoc.mjs --install。',
  },
  'E-ARCHIVE': {
    code: 'E-ARCHIVE',
    reason: '压缩包打包或解压失败',
    hint: '请确认文件完整；目前仅支持常见 ZIP（store / deflate）。',
  },
  'E-SUBTITLE': {
    code: 'E-SUBTITLE',
    reason: '字幕转换失败',
    hint: '请确认字幕为有效的 srt / vtt / ass / ssa 文件。',
  },
  'E-PATH-MISSING': {
    code: 'E-PATH-MISSING',
    reason: '文件没有可用的本地路径，或输入不存在',
    hint: '请用「选择文件」对话框添加，避免仅使用无路径的浏览器文件。',
  },
  'E-ENGINE-UNAVAILABLE': {
    code: 'E-ENGINE-UNAVAILABLE',
    reason: '当前环境无法调用本机引擎',
    hint: '请用 npm run dev 启动桌面端；若引擎未安装，请先到设置里查看引擎状态。',
  },
  'E-SPECIAL-MUSIC': {
    code: 'E-SPECIAL-MUSIC',
    reason: '特殊音乐格式需要外部合法工具，应用内不会解密',
    hint: '请仅处理你有权使用的文件，并用外部合法工具转换。',
  },
  'E-VOCAL-MISSING': {
    code: 'E-VOCAL-MISSING',
    reason: '人声分离引擎未就绪',
    hint: '请按页面指引安装 Demucs，或改用已就绪的备用方案。',
  },
  'E-VOCAL-FAILED': {
    code: 'E-VOCAL-FAILED',
    reason: '人声分离失败',
    hint: '请确认音频完好，并查看详情中的引擎输出。',
  },
  'E-DISK-SPACE': {
    code: 'E-DISK-SPACE',
    reason: '目标磁盘空间不足',
    hint: '请清理目标盘空间，或改存到空间更大的位置后再转。',
  },
  'E-CANCELLED': {
    code: 'E-CANCELLED',
    reason: '任务已取消',
    hint: '未保留本次输出。可重新开始转换。',
  },
  'E-TIMEOUT': {
    code: 'E-TIMEOUT',
    reason: '转换超时',
    hint: '文件可能过大或引擎卡住。可稍后重试，或先转较小的文件。',
  },
  'E-UNKNOWN': {
    code: 'E-UNKNOWN',
    reason: '转换失败，原因未分类',
    hint: '可查看详情中的原始信息，或稍后重试。',
  },
}

const PATTERNS: Array<[RegExp, string]> = [
  [/磁盘空间不足|ENOSPC|no space left/i, 'E-DISK-SPACE'],
  [/任务已取消|E-CANCELLED|cancelled/i, 'E-CANCELLED'],
  [/\[timeout]|转换超时|timed out/i, 'E-TIMEOUT'],
  [/未(找到|检测到)\s*FFmpeg|未找到 FFmpeg|ffmpeg is not recognized/i, 'E-FFMPEG-MISSING'],
  [/FFmpeg 退出码|无法启动 FFmpeg|FFmpeg 失败|FFmpeg 简易分离失败|FFmpeg 图片转换失败/i, 'E-FFMPEG-FAILED'],
  [/未(找到|检测到)\s*LibreOffice|未找到 LibreOffice|soffice/i, 'E-LO-MISSING'],
  [/LibreOffice 退出码|LibreOffice 未生成|LibreOffice 转/i, 'E-LO-FAILED'],
  [/加密\/解密需要填写密码|加密需要提供|解密需要提供|密码/i, 'E-PDF-PASSWORD'],
  [/合并至少需要/i, 'E-PDF-MERGE-MIN'],
  [/未找到 pdftoppm|未找到 pdftotext|Poppler/i, 'E-PDF-POPPLER'],
  [/未找到 qpdf|qpdf 加密失败|qpdf 解密失败/i, 'E-PDF-QPDF'],
  [/无法加载 PDF|PDF 无页面|不支持的 PDF|PDF→/i, 'E-PDF-FAILED'],
  [/未(检测到|安装)\s*Sharp|未安装 sharp/i, 'E-IMAGE-SHARP'],
  [/RAW|LibRaw|dcraw|all-black|全黑/i, 'E-RAW-DECODE'],
  [/图片转换失败|解码失败|不支持的图片目标|Sharp 未写出/i, 'E-IMAGE-FAILED'],
  [/未(找到|检测到)\s*Tesseract|缺少 Tesseract 语言包|语言包加载失败/i, 'E-OCR-MISSING'],
  [/Tesseract 失败|OCR 失败|OCR 文本已识别/i, 'E-OCR-FAILED'],
  [/未(找到|检测到)\s*Pandoc|Pandoc 退出码|Pandoc 未生成|电子书引擎/i, 'E-EBOOK-PANDOC'],
  [/打包失败|解压失败|不是有效的 ZIP|ZIP 未写出|压缩包/i, 'E-ARCHIVE'],
  [/字幕/i, 'E-SUBTITLE'],
  [/没有本地路径|输入文件不存在|输入不存在|没有输入/i, 'E-PATH-MISSING'],
  [/不在 Electron 环境|引擎未接入/i, 'E-ENGINE-UNAVAILABLE'],
  [/特殊音乐|不内置破解|不破解/i, 'E-SPECIAL-MUSIC'],
  [/Demucs 未安装|未找到可用的 Python|UVR · VR|UVR · MDX-Net 未就绪|所选模型当前不可用/i, 'E-VOCAL-MISSING'],
  [/无法启动 Demucs|无法启动 UVR|UVR MDX-Net 退出码|未勾选任何输出轨道/i, 'E-VOCAL-FAILED'],
]

export function getErrorEntry(code?: string | null): ErrorCatalogEntry {
  if (code && ERROR_CATALOG[code]) return ERROR_CATALOG[code]
  return ERROR_CATALOG['E-UNKNOWN']
}

/** 根据错误码或关键词从目录里取出给用户看的原因和提示。 */
export function classifyError(message?: string | null, code?: string | null): ErrorCatalogEntry {
  if (code && ERROR_CATALOG[code]) return ERROR_CATALOG[code]
  const text = String(message ?? '').trim()
  if (!text) return ERROR_CATALOG['E-UNKNOWN']
  for (const [re, id] of PATTERNS) {
    if (re.test(text)) {
      // LibreOffice 路径里 “未找到” 走 MISSING，其余失败走 FAILED
      if (id === 'E-LO-MISSING' && /退出码|未生成|失败/.test(text) && !/未找到|未检测/.test(text)) {
        return getErrorEntry('E-LO-FAILED')
      }
      return getErrorEntry(id)
    }
  }
  return getErrorEntry('E-UNKNOWN')
}

export function formatFailureReason(message?: string | null, code?: string | null): string {
  return `可能原因：${classifyError(message, code).reason}`
}

/** 失败 toast 用的短文案，避免把整段引擎日志弹出来。 */
export function shortFailureToast(message?: string | null, code?: string | null): string {
  const entry = classifyError(message, code)
  if (entry.code === 'E-DISK-SPACE' && message && /转换大约需要/.test(message)) {
    const m = message.match(/转换大约需要[^，,]+，当前仅剩[^。.\n]+/)
    if (m) return `转换失败 · 可能原因：目标磁盘空间不足，${m[0]}`
  }
  return `转换失败 · 可能原因：${entry.reason}`
}
