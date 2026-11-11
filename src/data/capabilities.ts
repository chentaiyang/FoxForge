/**
 * 灵狐工坊能力矩阵（UI 展示用；真实转换由本机引擎执行）。
 *
 * ENGINE_HEALTH 含 10 项，其中「特殊音乐模块」永远是 optional、从不 ready，
 * 但仍计入总数。estimateExportBytes 与主进程 displayEstimateBytes 对齐（偏紧、给用户看），
 * 不要拿它去做磁盘预占——占盘要用更宽的 estimateOutputBytes。
 */

export type SourceGroup =
  | 'image'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'ebook'
  | 'subtitle'
  | 'archive'
  | 'specialMusic'
  | 'unknown'

export interface FormatGroup {
  id: SourceGroup
  title: string
  titleEn: string
  inputs: string[]
  targets: string[]
  note?: string
  engineHint: string
  /** 特殊分区：需要合规提示 */
  legalNotice?: string
  experimental?: string[]
}

export const VIDEO_CODECS = [
  { id: 'h264', label: 'H.264', hint: '兼容性最好' },
  { id: 'h265', label: 'H.265 / HEVC', hint: '体积更小' },
  { id: 'av1', label: 'AV1', hint: '新一代编码' },
  { id: 'copy', label: '流复制 copy', hint: '不重编码，仅换容器' },
] as const

export const PDF_ACTIONS = [
  { id: 'convert', label: '格式转换' },
  { id: 'split', label: '拆分（逐页 PDF）' },
  { id: 'merge', label: '多 PDF 合并' },
  { id: 'encrypt', label: 'AES-256 加密' },
  { id: 'decrypt', label: '解密（需密码）' },
  { id: 'ocr', label: 'OCR 文字识别（Tesseract）' },
] as const

export const FORMAT_GROUPS: FormatGroup[] = [
  {
    id: 'image',
    title: '图片',
    titleEn: 'Images',
    inputs: [
      'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff', 'bmp',
      'heic', 'heif', 'ico', 'tga', 'svg', 'jp2', 'j2k', 'jxl', 'qoi', 'ppm',
      'ai', 'psd',
      'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'pef', 'srw',
    ],
    targets: [
      'png', 'jpg', 'webp', 'gif', 'avif', 'tiff', 'ico', 'bmp', 'tga',
      'jp2', 'jxl', 'qoi', 'ppm', 'pdf', 'mp4', 'webm',
      'txt', 'md', 'docx',
    ],
    note: '常见格式本机直转；RAW 经 dcraw/libraw；PSD 取合成图；AI 需 PDF 兼容；JPEG 2000 / JPEG XL / QOI 经 FFmpeg；OCR 可输出 TXT / MD / DOCX。CR3 等新 RAW 取决于解码器版本。',
    engineHint: 'Sharp',
  },
  {
    id: 'document',
    title: '文档 Office / WPS',
    titleEn: 'Documents',
    inputs: ['doc', 'docx', 'odt', 'rtf', 'wps', 'wpt', 'wpd', 'ofd'],
    targets: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'md'],
    experimental: ['OFD'],
    note: 'Word / WPS 走 LibreOffice；Markdown 请走电子书。OFD 暂不支持（开源引擎不成熟，未捆绑可靠本地转换）。',
    engineHint: 'LibreOffice',
  },
  {
    id: 'spreadsheet',
    title: '表格',
    titleEn: 'Spreadsheets',
    inputs: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'et', 'ett'],
    targets: ['pdf', 'xlsx', 'xls', 'ods', 'csv', 'html'],
    note: 'ET / ETT 由 LibreOffice 按 Excel 97 兼容打开。',
    engineHint: 'LibreOffice',
  },
  {
    id: 'presentation',
    title: '演示 PPT',
    titleEn: 'Presentations',
    inputs: ['ppt', 'pptx', 'odp', 'dps', 'dpt'],
    targets: ['pdf', 'pptx', 'odp', 'html', 'png', 'jpg'],
    note: 'DPS / DPT 由 LibreOffice 按 PPT / POT 兼容打开。',
    engineHint: 'LibreOffice',
  },
  {
    id: 'pdf',
    title: 'PDF',
    titleEn: 'PDF',
    inputs: ['pdf'],
    targets: ['xlsx', 'txt', 'html', 'docx', 'md', 'png', 'jpg', 'webp', 'pdf'],
    note: '支持拆分、合并、加密，以及转图片、文本和 OCR。',
    engineHint: 'Poppler · qpdf',
  },
  {
    id: 'audio',
    title: '普通音频',
    titleEn: 'Audio',
    inputs: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'],
    targets: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus', 'wma'],
    engineHint: 'FFmpeg',
  },
  {
    id: 'video',
    title: '普通视频',
    titleEn: 'Video',
    inputs: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mts', 'm2ts', 'ts'],
    targets: ['mp4', 'webm', 'mkv', 'mov', 'gif', 'mp3', 'wav', 'flac', 'm4a'],
    note: '编码可选 H.264、H.265、AV1，或只换容器不重编码。',
    engineHint: 'FFmpeg',
  },
  {
    id: 'ebook',
    title: '电子书 / 文本',
    titleEn: 'E-books & Text',
    inputs: ['txt', 'md', 'html', 'json', 'xml', 'yaml', 'epub', 'mobi', 'azw', 'azw3'],
    targets: ['txt', 'md', 'html', 'epub', 'pdf', 'docx'],
    note: '文本与 EPUB 互转；JSON / XML / YAML 先转成可读 Markdown。MOBI 可解包，AZW3 建议安装 Calibre。不写入 MOBI（无 kindlegen）。',
    engineHint: 'Pandoc',
  },
  {
    id: 'subtitle',
    title: '字幕',
    titleEn: 'Subtitles',
    inputs: ['srt', 'vtt', 'ass', 'ssa'],
    targets: ['srt', 'vtt', 'ass', 'ssa', 'txt'],
    engineHint: '内置',
  },
  {
    id: 'archive',
    title: '压缩包',
    titleEn: 'Archives',
    inputs: ['zip'],
    targets: ['解压', 'zip'],
    note: '解压到源文件同目录文件夹；多文件可选 ZIP 打包。尽量保留 UTF-8 / 中文文件名。',
    engineHint: '内置',
  },
  {
    id: 'specialMusic',
    title: '特殊音乐',
    titleEn: 'Platform music (optional)',
    inputs: ['ncm', 'mgg', 'mflac', 'kgm', 'kgma', 'qmc0', 'qmc3', 'kwm', 'vpr'],
    targets: ['mp3', 'flac', 'wav', 'm4a'],
    note: '平台封装格式需外部合法工具处理，应用内不破解。',
    engineHint: '不内置',
    legalNotice:
      '仅限处理你合法拥有或获得授权的文件。如需转换请使用外部合法工具——应用内不内置破解/解密。本产品不提供绕过付费或传播未授权内容的指导；使用后果自负。',
  },
]

export interface EngineHealthItem {
  id: string
  name: string
  status: 'ready' | 'missing' | 'optional'
  covers: string
}

/** 静态默认清单；设置页会用主进程探测结果覆盖 */
export const ENGINE_HEALTH: EngineHealthItem[] = [
  { id: 'ffmpeg', name: 'FFmpeg', status: 'missing', covers: '普通音视频' },
  { id: 'libreoffice', name: 'LibreOffice', status: 'missing', covers: 'Office / WPS' },
  { id: 'poppler', name: 'Poppler', status: 'missing', covers: 'PDF 渲染' },
  { id: 'qpdf', name: 'qpdf', status: 'missing', covers: 'PDF 加密' },
  { id: 'tesseract', name: 'Tesseract OCR', status: 'missing', covers: 'OCR' },
  { id: 'pandoc', name: 'Pandoc', status: 'missing', covers: 'Markdown / 电子书（探测覆盖）' },
  { id: 'sharp', name: 'Sharp', status: 'missing', covers: '图片互转 / 多图→PDF' },
  { id: 'libraw', name: 'libraw / dcraw', status: 'optional', covers: 'RAW' },
  { id: 'demucs', name: 'Demucs（人声分离）', status: 'missing', covers: '人声 / 伴奏 / 四轨' },
  { id: 'musicUnlock', name: '特殊音乐模块', status: 'optional', covers: '需外部合法工具，应用内不破解' },
]

const EXT_TO_GROUP = new Map<string, SourceGroup>()
for (const g of FORMAT_GROUPS) {
  for (const ext of g.inputs) {
    EXT_TO_GROUP.set(ext.toLowerCase(), g.id)
  }
}

export function extOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  if (i < 0) return ''
  return filename.slice(i + 1).toLowerCase()
}

/** 按后缀判断文件分组；常见 RAW 后缀即使未写进矩阵也归入图片。 */
export function detectGroup(filename: string): SourceGroup {
  const ext = extOf(filename)
  if (!ext) return 'unknown'
  // RAW 常见后缀归入图片
  if (['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'raf', 'pef', 'srw'].includes(ext)) return 'image'
  return EXT_TO_GROUP.get(ext) ?? 'unknown'
}

export function groupById(id: SourceGroup): FormatGroup | undefined {
  return FORMAT_GROUPS.find((g) => g.id === id)
}

export function targetsForFile(filename: string): string[] {
  const g = groupById(detectGroup(filename))
  return g?.targets ?? []
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export type ExportEstimateKind =
  | 'media'
  | 'audio'
  | 'video'
  | 'image'
  | 'document'
  | 'pdf'
  | 'archive'
  | 'ebook'
  | 'subtitle'
  | 'ocr'
  | 'generic'

/** 渲染进程给用户看的偏紧估算，与主进程 displayEstimateBytes 对齐（此处没有时长信息）。不要拿它去占盘。 */
export function estimateExportBytes(inputBytes: number, kind: ExportEstimateKind, _fileCount = 1): number {
  const raw = Math.max(0, inputBytes)
  switch (kind) {
    case 'video':
    case 'media':
      return Math.max(Math.ceil(raw * 1.1), 256 * 1024)
    case 'audio':
      return Math.max(Math.ceil(raw * 1.1), 64 * 1024)
    case 'image':
      return Math.max(Math.ceil(raw * 1.15), 4096)
    case 'archive':
      return Math.max(Math.ceil(raw * 0.95), 4096)
    case 'subtitle':
      return Math.max(Math.ceil(raw * 1.3), 1024)
    case 'ocr':
      return Math.max(Math.min(raw, 2 * 1024 * 1024), 8 * 1024)
    default:
      return Math.max(Math.ceil(raw * 1.2), 16 * 1024)
  }
}
