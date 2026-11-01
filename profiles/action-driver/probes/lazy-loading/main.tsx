import { systemClock } from '@action-driver/platform-core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PageContributionRegistry } from '@action-driver/workbench-core'
import { ContributedPage, PageViewRegistry, DeferredContent } from '@action-driver/workbench-ui'
import { createViewportObserver } from '@probe-renderer/di/viewport-environment'
import { PageContributionFallback } from '@probe-renderer/components/page-composition/PageContributionFallback'
import { ConversationViewport } from '@probe-renderer/components/ConversationViewport'

const declarations = new PageContributionRegistry()
const owner = { id: 'fixture', instanceId: 'v1' }
declarations.register(owner, [{ id: 'fixture', pageType: 'fixture', contractVersion: 1, stateVersion: 1, scope: 'workbench', closable: false }])
const views = new PageViewRegistry<{ fixture: { text: string } }>(systemClock, declarations, crypto.randomUUID())
let attempts = 0
views.bind(owner, 'fixture', async () => {
  attempts++
  if (attempts === 1) throw new Error('固定加载失败')
  return { default: ({ text }) => <p>{text} · 加载次数 {attempts}</p> }
})
const observe = createViewportObserver(window)
function History({ index }: { index: number }) {
  const [expanded, setExpanded] = useState(false)
  return <article><h3>历史回合 {index}</h3><button onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开'} {index}</button>
    {expanded ? <p>保留的历史详情 {index}</p> : null}<p>固定文本样例，无任务、宿主或网络操作。</p></article>
}
function Fixture() {
  const [tail, setTail] = useState('固定流式尾部')
  return <main><h1>按需加载固定样例</h1><h2>显式重试</h2>
    <ContributedPage registry={views} pageType="fixture" instanceId="original" stateVersion={1} viewProps={{ text: '原资源恢复成功' }}
      fallback={(reason, retry) => <PageContributionFallback reason={reason} onRetry={retry} />} />
    <h2>长会话视口</h2><button onClick={() => setTail(value => value + ' update')}>追加固定尾部</button><ConversationViewport followKey={tail}>
      <div>{Array.from({ length: 40 }, (_, index) => <DeferredContent key={index} observe={observe} immediate={index >= 38}><History index={index} /></DeferredContent>)}</div>
      <p id="stream-tail">{tail}</p>
    </ConversationViewport></main>
}
const style = document.createElement('style')
style.textContent = 'body{font:16px system-ui;background:#f6f6f6;color:#222}main{max-width:850px;margin:32px auto}button{padding:8px 14px;margin:8px;border:1px solid #ccc;border-radius:8px;background:white}.conversation-scroll{height:440px;overflow:auto;background:white;border:1px solid #ddd;border-radius:12px;padding:16px}article{min-height:180px;border-bottom:1px solid #ddd;padding:16px}.workspace-page-fallback{padding:18px;background:#fff0ed;border-radius:10px}.conversation-jump{position:sticky;bottom:0;text-align:center}'
document.head.append(style)
createRoot(document.getElementById('root')!).render(<Fixture />)
