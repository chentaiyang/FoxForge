/**
 * 内置 MOBI / AZW3 拆包：把 PalmDOC / KF8 尽量还原成 HTML，必要时再从内嵌 EPUB 抢救。
 * 不处理 DRM。供电子书引擎和冒烟测试构造最小 MOBI 使用。
 */
import fs from 'node:fs'
import path from 'node:path'

function u16(buf: Buffer, off: number) {
  return buf.readUInt16BE(off)
}
function u32(buf: Buffer, off: number) {
  return buf.readUInt32BE(off)
}

/** PalmDOC 类 LZ77 解压 */
export function palmdocDecompress(src: Buffer, expected?: number): Buffer {
  const out: number[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i++]
    if (c === 0) {
      out.push(0)
    } else if (c >= 1 && c <= 8) {
      for (let k = 0; k < c && i < src.length; k++) out.push(src[i++])
    } else if (c >= 0x80 && c <= 0xbf) {
      if (i >= src.length) break
      const c2 = src[i++]
      const dist = (((c & 0x3f) << 8) | c2) >> 3
      const len = (c2 & 7) + 3
      if (dist <= 0 || dist > out.length) continue
      for (let k = 0; k < len; k++) out.push(out[out.length - dist])
    } else if (c >= 0xc0) {
      out.push(0x20, c ^ 0x80)
    } else {
      out.push(c)
    }
    if (expected && out.length >= expected) break
  }
  return Buffer.from(out)
}

/** 把 MOBI / AZW3 尽量拆成 HTML；不处理 DRM。 */
export function unpackMobiToHtml(inputPath: string, outputHtml: string): { encoding: string; engine: string } {
  const buf = fs.readFileSync(inputPath)
  if (buf.length < 86) throw new Error('文件太小，不是有效的 MOBI/AZW。')
  const type = buf.subarray(60, 64).toString('latin1')
  const creator = buf.subarray(64, 68).toString('latin1')
  if (!['BOOK', 'TEXt'].includes(type) && creator !== 'MOBI' && creator !== 'READ') {
    // 后面若能找到 MOBI 头仍继续尝试
  }
  const recCount = u16(buf, 76)
  if (recCount < 2) throw new Error('MOBI 记录数不足。')
  const records: number[] = []
  for (let i = 0; i < recCount; i++) {
    records.push(u32(buf, 78 + i * 8))
  }
  const rec0 = records[0]
  const rec0End = records[1] ?? buf.length
  if (rec0 + 16 > buf.length) throw new Error('MOBI 头偏移无效。')
  const rec0buf = buf.subarray(rec0, rec0End)
  const compression = u16(rec0buf, 0)
  const encryption = u16(rec0buf, 12)
  if (encryption && encryption !== 0) {
    throw new Error('该 MOBI/AZW 已加密，无法在应用内解密（不处理 DRM）。请提供未加密文件，或用已授权的外部工具。')
  }
  const textLength = u32(rec0buf, 4)
  const textRecords = u16(rec0buf, 8)
  let encoding = 'windows-1252'
  let firstContent = 1
  let extraDataFlags = 0
  if (rec0buf.length >= 20 && rec0buf.subarray(16, 20).toString('latin1') === 'MOBI') {
    const headerLen = u32(rec0buf, 20)
    const encCode = u32(rec0buf, 28)
    if (encCode === 65001) encoding = 'utf8'
    else if (encCode === 1252) encoding = 'windows-1252'
    // 第一条内容记录常常在偏移 80 附近；找不到时默认 1
    if (headerLen >= 0x74 && 0x50 + 4 <= rec0buf.length) {
      // MOBI 头从 16 开始，第一张图索引约在 MOBI 起点 + 0x6C
    }
    // 额外数据标志：从 MOBI 起点（偏移 16）再加 0xF0，长度足够时才读
    const extraOff = 16 + 0xf0
    if (headerLen >= 0xf2 && extraOff + 4 <= rec0buf.length) {
      extraDataFlags = u16(rec0buf, extraOff)
    }
    // KF8 / AZW3：寻找 EXTH、BOUNDARY，或以 PK 开头的内嵌 zip
  }

  const trailBytes = (data: Buffer): Buffer => {
    if (!extraDataFlags) return data
    let end = data.length
    let flags = extraDataFlags >> 1
    while (flags) {
      if (flags & 1) {
        if (end < 1) break
        const size = multibyteSize(data, end - 1)
        end -= size
      }
      flags >>= 1
    }
    return Buffer.from(data.subarray(0, Math.max(0, end)))
  }

  const chunks: Buffer[] = []
  const nText = Math.max(1, textRecords)
  for (let i = 0; i < nText; i++) {
    const idx = firstContent + i
    if (idx >= records.length) break
    const start = records[idx]
    const end = idx + 1 < records.length ? records[idx + 1] : buf.length
    if (start >= buf.length) break
    let slice: Buffer = Buffer.from(buf.subarray(start, Math.min(end, buf.length)))
    slice = trailBytes(slice)
    if (compression === 2) chunks.push(palmdocDecompress(slice))
    else if (compression === 1) chunks.push(Buffer.from(slice))
    else if (compression === 17480) {
      throw new Error('该 MOBI 使用 HUFF/CDIC 压缩，当前内置解包不支持。请安装 Calibre（ebook-convert）后重试。')
    } else {
      throw new Error(`不支持的 MOBI 压缩类型 ${compression}。`)
    }
  }

  let textBuf = Buffer.concat(chunks)
  if (textLength && textBuf.length > textLength) textBuf = Buffer.from(textBuf.subarray(0, textLength))

  // AZW3 / KF8 常常内嵌 EPUB zip；HTML 看起来是空的就尝试抢救
  const zipAt = buf.indexOf(Buffer.from('PK\x03\x04'))
  let html = decodeText(textBuf, encoding)
  if ((!html.trim() || html.includes('KINDLE:EMBED')) && zipAt > 0) {
    // 保目前的 HTML，调用方也许还能用
  }
  if (!html.trim()) {
    throw new Error('解包后文本为空。文件可能是 AZW3/KF8，需要 Calibre。')
  }
  // 看起来不像 HTML 就包一层
  if (!/<(html|body|p|head|book)/i.test(html)) {
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><pre>${escapeHtml(html)}</pre></body></html>`
  } else if (!/<meta[^>]+charset/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}<meta charset="utf-8">`)
    if (!/<head/i.test(html)) {
      html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`
    }
  }
  fs.mkdirSync(path.dirname(outputHtml), { recursive: true })
  fs.writeFileSync(outputHtml, html, 'utf8')
  return { encoding, engine: compression === 2 ? 'mobi-unpack/palmdoc' : 'mobi-unpack' }
}

function multibyteSize(data: Buffer, pos: number): number {
  let size = 0
  let p = pos
  let seen = 0
  while (p >= 0 && seen < 4) {
    const v = data[p]
    size |= (v & 0x7f)
    seen++
    if (v & 0x80) break
    size <<= 7
    p--
  }
  return Math.max(1, size)
}

function decodeText(buf: Buffer, encoding: string): string {
  if (encoding === 'utf8') return buf.toString('utf8')
  try {
    return new TextDecoder('windows-1252').decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 构造一个很小的、未压缩也未加密的 MOBI，供冒烟测试使用。 */
export function writeMinimalMobi(html: string, outputPath: string): void {
  const text = Buffer.from(html, 'utf8')
  const recSize = 4096
  const textRecords: Buffer[] = []
  for (let i = 0; i < text.length; i += recSize) {
    textRecords.push(text.subarray(i, Math.min(text.length, i + recSize)))
  }
  if (!textRecords.length) textRecords.push(Buffer.alloc(0))

  const palmdoc = Buffer.alloc(16)
  palmdoc.writeUInt16BE(1, 0) // uncompressed
  palmdoc.writeUInt32BE(text.length, 4)
  palmdoc.writeUInt16BE(textRecords.length, 8)
  palmdoc.writeUInt16BE(recSize, 10)

  const mobiHeaderLen = 0xe8
  const mobi = Buffer.alloc(mobiHeaderLen)
  mobi.write('MOBI', 0)
  mobi.writeUInt32BE(mobiHeaderLen, 4)
  mobi.writeUInt32BE(2, 8) // type book
  mobi.writeUInt32BE(65001, 12) // utf-8
  mobi.writeUInt32BE(1, 16) // uid
  mobi.writeUInt32BE(6, 20) // file version
  // 第一条非书籍记录索引等字段先留 0
  // 全名偏移和长度可随后再填，这里可省略

  const rec0 = Buffer.concat([palmdoc, mobi])
  const allRecords = [rec0, ...textRecords]
  const recCount = allRecords.length

  const header = Buffer.alloc(78)
  const name = Buffer.from('MediaForgeSmoke').subarray(0, 32)
  name.copy(header, 0)
  header.write('BOOK', 60)
  header.write('MOBI', 64)
  header.writeUInt16BE(recCount, 76)

  const recList = Buffer.alloc(recCount * 8 + 2)
  let offset = 78 + recCount * 8 + 2
  for (let i = 0; i < recCount; i++) {
    recList.writeUInt32BE(offset, i * 8)
    recList.writeUInt8(0, i * 8 + 4)
    recList.writeUIntBE(i, i * 8 + 5, 3)
    offset += allRecords[i].length
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, Buffer.concat([header, recList, ...allRecords]))
}
