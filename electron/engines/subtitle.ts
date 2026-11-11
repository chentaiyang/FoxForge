/**
 * 字幕转换引擎：SRT / ASS / VTT 等文本字幕互转，不内嵌到视频轨道。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ConvertProgressEvent, ConvertResult } from './types'
import { defaultOutputPath, extOf } from './bins'
import { atomicWriteOutput, cancelledResult, failResult, isCancelRequested, remapIfCancelled, decorateProgress } from './jobs'

export interface ConvertSubtitleRequest {
  inputPath: string
  target: string
  outputPath?: string
}

const SUB_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa', 'txt'])

function parseTs(raw: string): number | null {
  const s = raw.trim().replace(',', '.')
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (![h, min, sec].every(Number.isFinite)) return null
  return h * 3600 + min * 60 + sec
}

function fmtSrt(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
}

function fmtVtt(sec: number): string {
  return fmtSrt(sec).replace(',', '.')
}

function fmtAss(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

interface Cue {
  start: number
  end: number
  text: string
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim()
}

function parseSrt(content: string): Cue[] {
  const parts = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split(/\n\s*\n/)
  const cues: Cue[] = []
  for (const block of parts) {
    const rawLines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
    const lines =
      rawLines.length > 1 && /^\d+$/.test(rawLines[0].trim()) ? rawLines.slice(1) : rawLines
    if (!lines.length) continue
    const m = lines[0].match(/(.+?)\s*-->\s*(.+)/)
    if (!m) continue
    const start = parseTs(m[1].replace(',', '.'))
    const end = parseTs(m[2].replace(',', '.').split(/\s+/)[0])
    if (start == null || end == null) continue
    const text = lines.slice(1).join('\n').trim()
    cues.push({ start, end, text })
  }
  return cues
}

function parseVtt(content: string): Cue[] {
  let body = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  body = body.replace(/^WEBVTT[^\n]*\n/, '')
  // drop NOTE / STYLE blocks roughly
  body = body.replace(/^(NOTE|STYLE|REGION)[\s\S]*?(?=\n\s*\n)/gm, '')
  return parseSrt(body)
}

function parseAss(content: string): Cue[] {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  let format: string[] | null = null
  const cues: Cue[] = []
  let inEvents = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\[events\]/i.test(line.trim())) {
      inEvents = true
      format = null
      continue
    }
    if (/^\[/.test(line.trim()) && !/^\[events\]/i.test(line.trim())) {
      inEvents = false
      continue
    }
    if (!inEvents) continue
    if (/^format:/i.test(line)) {
      format = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase())
      continue
    }
    const isDlg = /^dialogue:/i.test(line)
    if (!isDlg) continue
    const rest = line.slice(line.indexOf(':') + 1)
    // Dialogue 字段以逗号分隔；正文在最后一段，里面还可能有逗号
    const cols = format && format.length ? format : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
    const textIdx = cols.indexOf('text') >= 0 ? cols.indexOf('text') : cols.length - 1
    const parts: string[] = []
    let cur = ''
    let seen = 0
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i]
      if (ch === ',' && seen < textIdx) {
        parts.push(cur)
        cur = ''
        seen++
      } else {
        cur += ch
      }
    }
    parts.push(cur)
    const get = (key: string) => {
      const idx = cols.indexOf(key)
      return idx >= 0 ? (parts[idx] || '').trim() : ''
    }
    const start = parseTs(get('start'))
    const end = parseTs(get('end'))
    if (start == null || end == null) continue
    const text = get('text').replace(/\\N/g, '\n').replace(/\\n/g, '\n')
    cues.push({ start, end, text: stripTags(text) })
  }
  return cues
}

function parseCues(content: string, ext: string): Cue[] {
  if (ext === 'vtt') return parseVtt(content)
  if (ext === 'ass' || ext === 'ssa') return parseAss(content)
  if (ext === 'srt') return parseSrt(content)
  if (ext === 'txt') {
    // plain text: one cue covering a dummy span so conversion can at least wrap
    const text = content.replace(/^\uFEFF/, '').trim()
    return text ? [{ start: 0, end: 2, text }] : []
  }
  return parseSrt(content)
}

function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(c.end)}\n${c.text.trim()}\n`)
    .join('\n') + (cues.length ? '\n' : '')
}

function toVtt(cues: Cue[]): string {
  const body = cues
    .map((c) => `${fmtVtt(c.start)} --> ${fmtVtt(c.end)}\n${c.text.trim()}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`
}

function toAss(cues: Cue[]): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const ev = cues
    .map((c) => `Dialogue: 0,${fmtAss(c.start)},${fmtAss(c.end)},Default,,0,0,0,,${c.text.trim().replace(/\n/g, '\\N')}`)
    .join('\n')
  return header + ev + (ev ? '\n' : '')
}

function toTxt(cues: Cue[]): string {
  return cues.map((c) => stripTags(c.text)).filter(Boolean).join('\n\n') + (cues.length ? '\n' : '')
}

export function isSubtitleGroup(group: string): boolean {
  return group === 'subtitle'
}

export function isSubtitleConvertible(target: string): boolean {
  return SUB_EXTS.has(target.toLowerCase())
}

/** 字幕文本格式互转（SRT / ASS / VTT 等），不烧进视频。 */
export async function convertSubtitle(
  req: ConvertSubtitleRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const inputPath = req.inputPath
  if (!inputPath || !fs.existsSync(inputPath)) {
    return failResult(jobId, 'E-PATH-MISSING', `输入文件不存在：${inputPath}`)
  }
  const inExt = extOf(inputPath)
  if (!SUB_EXTS.has(inExt)) {
    return failResult(jobId, 'E-SUBTITLE', `不支持的字幕输入：.${inExt}。可用 srt / vtt / ass / ssa。`)
  }
  const target = (req.target || '').toLowerCase()
  if (!SUB_EXTS.has(target)) {
    return failResult(jobId, 'E-SUBTITLE', `不支持的字幕目标：${req.target}。可用 srt / vtt / ass / ssa / txt。`)
  }
  onProgress({ jobId, percent: 20, message: `字幕 ${inExt}→${target}` })
  const content = fs.readFileSync(inputPath, 'utf8')
  const cues = parseCues(content, inExt)
  if (!cues.length) {
    return failResult(jobId, 'E-SUBTITLE', '未能解析出任何字幕条目。请检查文件是否为有效 srt/vtt/ass。')
  }
  let out = ''
  if (target === 'srt') out = toSrt(cues)
  else if (target === 'vtt') out = toVtt(cues)
  else if (target === 'ass' || target === 'ssa') out = toAss(cues)
  else out = toTxt(cues)

  if (isCancelRequested(jobId)) return cancelledResult(jobId)
  const outputPath = req.outputPath || defaultOutputPath(inputPath, target === 'ssa' ? 'ssa' : target)
  const committed = atomicWriteOutput(
    jobId,
    outputPath,
    Buffer.from(out, 'utf8'),
    { kind: 'subtitle', inputPaths: inputPath },
  )
  if (!committed.ok) return committed
  onProgress({ jobId, percent: 100, message: '完成', phase: 'finalize' })
  return remapIfCancelled(jobId, { jobId, ok: true, outputPath: committed.outputPath, engineUsed: '内置字幕' })
}
