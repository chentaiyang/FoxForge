/**
 * 「更多」页：侧边栏扩展位，目前只展示规划中的模块卡片，没有实际功能入口。
 */
/** 「更多」占位页。 */
export default function MorePage() {
  const ideas = [
    { title: '批量队列中心', desc: '跨页多任务并行、失败重试、输出目录管理' },
    { title: '插件 / 模型市场', desc: '按需下载 FFmpeg 包、OCR 语言包、Demucs 权重' },
    { title: '历史记录', desc: '最近转换、一键打开输出文件夹' },
    { title: '网页版入口', desc: '轻量功能浏览器直开；重活走本机或云 Worker' },
    { title: '诊断导出', desc: '引擎探测日志、一键打包反馈（对标飞鼠诊断）' },
    { title: 'Agent / CLI', desc: '命令行与外部 Agent 接入（后置优先级）' },
  ]

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>更多</h1>
          <p>侧边栏扩展位。飞鼠是单页工作台；我们用多入口把能力摊开，方便以后加模块。</p>
        </div>
      </header>
      <div className="category-grid">
        {ideas.map((item) => (
          <div key={item.title} className="category-card placeholder">
            <h3>{item.title}</h3>
            <p>{item.desc}</p>
            <span className="tag muted">规划中</span>
          </div>
        ))}
      </div>
    </div>
  )
}
