import { Profiler, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownContent } from '@probe-renderer/components/MarkdownContent'
import { ReadOnlyCode } from '@probe-renderer/components/ReadOnlyCode'
import { ToolDetails } from '@probe-renderer/components/agent/ToolDetails'
import { markdownBlocks } from '@probe-renderer/components/markdown-blocks'
import { createLocalRendererEnvironment, RendererEnvironmentProvider } from '@probe-renderer/di/environment'

const environment = createLocalRendererEnvironment(window)
const commits: number[] = []
function Fixture() {
  const [mode, setMode] = useState('text')
  const [tail, setTail] = useState('tail')
  const [report, setReport] = useState('')
  const prefix = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}: fixed completed text.\n\n`).join('')
  function measure() {
    const cases = [10_000, 100_000].map(size => {
      let source = '```text\n' + 'abcdef ghijklmnop\n'.repeat(Math.ceil(size / 17))
      const initialStart = performance.now()
      markdownBlocks(source)
      const initialMs = performance.now() - initialStart
      const ticks = Array.from({ length: 60 }, (_, index) => {
        source += `delta ${index}\n`
        const start = performance.now()
        markdownBlocks(source)
        return performance.now() - start
      }).sort((a, b) => a - b)
      return { chars: size, initialMs, p50Ms: ticks[30], p95Ms: ticks[57], maxMs: ticks[59] }
    })
    setReport(JSON.stringify({ parser: cases, reactCommitMs: commits.slice(-100), userAgent: navigator.userAgent }, null, 2))
  }
  return <main>
    <h1>内容性能固定样例</h1><p>仅固定文本与本地库，无账号、任务或宿主写入。</p>
    <input aria-label="响应测试输入" placeholder="测试输入响应" />
    <nav>{['text', 'codes', 'diagrams', 'compile', 'worker', 'recovery'].map(value => <button key={value} onClick={() => setMode(value)}>{value}</button>)}</nav>
    <button onClick={measure}>测量解析</button><button onClick={() => setTail(value => value + ' update')}>追加尾部</button>
    <Profiler id="content" onRender={(_id, _phase, duration) => commits.push(duration)}>
      {mode === 'recovery' && <ToolDetails details={{ input: [], output: [] }} summary="固定写入样例" status="unknown" />}
      {mode === 'text' && <MarkdownContent content={prefix + tail} />}
      {mode === 'codes' && Array.from({ length: 20 }, (_, i) => <ReadOnlyCode key={i} language="javascript" value={`const item${i} = ${i}`} />)}
      {mode === 'diagrams' && Array.from({ length: 3 }, (_, i) => <MarkdownContent key={i} content={`Diagram ${i}\n\n\`\`\`mermaid\nflowchart LR\n A --> B\n\`\`\`\n\n${tail}`} />)}
      {mode === 'compile' && <CompileProbe />}
      {mode === 'worker' && <WorkerProbe />}
    </Profiler>
    <pre id="report">{report}</pre>
  </main>
}
function CompileProbe() {
  const [report, setReport] = useState('')
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null)
  // This isolated fixture measures compilation only, never executes the resulting code.
  const source = `function App(){return <main>${'<div>fixed content</div>'.repeat(500)}</main>}`
  const doc = `<script src="${location.origin}/html-libraries/babel.min.js"></script><script>const times=[];for(let i=0;i<12;i++){const start=performance.now();Babel.transform(${JSON.stringify(source)},{presets:['react'],filename:'probe.jsx'});times.push(performance.now()-start)}parent.postMessage({type:'compile-probe',times},'*')</script>`
  return <div><iframe title="编译测量" ref={setFrame} sandbox="allow-scripts" srcDoc={doc} />
    <CompileResult frame={frame} report={report} setReport={setReport} /></div>
}
import { useEffect } from 'react'
function CompileResult({ frame, report, setReport }: { frame: HTMLIFrameElement | null; report: string; setReport(value: string): void }) {
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== 'null') return // sandboxed srcDoc frames have opaque origins
      if (event.source === frame?.contentWindow && event.data?.type === 'compile-probe') setReport(JSON.stringify(event.data.times))
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [frame, setReport])
  return <pre id="compile-report">{report}</pre>
}
createRoot(document.getElementById('root')!).render(<RendererEnvironmentProvider environment={environment}><Fixture /></RendererEnvironmentProvider>)

function WorkerProbe() {
  const [documents, setDocuments] = useState<string[]>([])
  const [reports, setReports] = useState<string[]>([])
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== 'null') return // sandboxed srcDoc frames have opaque origins
      if (!Array.from(document.querySelectorAll('iframe')).some(frame => frame.contentWindow === event.source)) return
      if (event.data?.type === 'worker-probe' || event.data?.type === 'action-driver-visualization-error') setReports(values => [...values, JSON.stringify(event.data)])
    }
    window.addEventListener('message', listener)
    void import('@probe-renderer/components/visualization-content').then(({ visualizationSrcDoc, canvasSrcDoc }) => {
      const jsx = '<main>' + '<div>fixed content</div>'.repeat(500) + '</main>'
      const html = '<script>window.ticks=0;window.start=performance.now();window.timer=setInterval(()=>window.ticks++,5)</script><script type="text/babel">const App=()=>'+jsx+'</script><script type="text/babel">ReactDOM.createRoot(document.getElementById("app")).render(<App/>);clearInterval(window.timer);parent.postMessage({type:"worker-probe",kind:"html",elapsedMs:performance.now()-window.start,ticks:window.ticks},"*")</script><div id="app"></div>'
      const canvas = 'export default function Panel(){const n: number=42;React.useEffect(()=>{parent.postMessage({type:"worker-probe",kind:"canvas",value:n},"*")},[]);return <div>Canvas {n}</div>}'
      setDocuments([visualizationSrcDoc(html, location.origin), canvasSrcDoc(canvas, location.origin, { kind: 'light' }), visualizationSrcDoc('<script type="text/babel">const invalid = <</script>', location.origin)])
    })
    return () => window.removeEventListener('message', listener)
  }, [])
  return <section>{documents.map((srcDoc, i) => <iframe key={i} title={`worker-${i}`} sandbox="allow-scripts" srcDoc={srcDoc} />)}<pre id="worker-report">{reports.join('\n')}</pre></section>
}
