/**
 * 工作台下方的能力一览。只展示 FORMAT_GROUPS，不发起转换。
 * 「特殊音乐」卡片标明不内置，应用内不破解。
 */
import { FORMAT_GROUPS } from '../../data/capabilities'

const ALIAS: Record<string, string> = {
  jpeg: 'jpg',
  tiff: 'tif',
  heif: 'heic',
}

function displayExts(exts: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of exts) {
    const key = ALIAS[raw.toLowerCase()] ?? raw.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

export default function FormatMatrix() {
  return (
    <section className="format-matrix panel">
      <div className="matrix-head">
        <h3>能力一览</h3>
        <p>已接入的引擎可直接转换。OFD 暂不支持；特殊音乐需外部合法工具，应用内不破解。</p>
      </div>
      <div className="matrix-grid">
        {FORMAT_GROUPS.map((g) => (
          <article key={g.id} className={`matrix-card${g.id === 'specialMusic' ? ' special' : ''}`}>
            <header>
              <h4>
                {g.title}
                {g.id === 'specialMusic' && <span className="tag accent">不内置</span>}
              </h4>
              <span className="engine-chip" title={g.engineHint}>
                {g.engineHint}
              </span>
            </header>
            {g.note && <p className="matrix-note">{g.note}</p>}
            <div className="matrix-cols">
              <div>
                <div className="matrix-label">输入</div>
                <div className="tag-row dense">
                  {displayExts(g.inputs).map((f) => (
                    <span key={f} className="tag">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="matrix-label">输出</div>
                <div className="tag-row dense">
                  {displayExts(g.targets).map((f) => (
                    <span key={f} className="tag out">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            {g.experimental && g.experimental.length > 0 && (
              <p className="matrix-exp">占位：{g.experimental.join(' · ')}</p>
            )}
            {g.legalNotice && <p className="legal-banner compact">{g.legalNotice}</p>}
          </article>
        ))}
      </div>
    </section>
  )
}
