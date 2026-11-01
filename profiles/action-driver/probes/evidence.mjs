import {fileURLToPath} from 'node:url'
// Capture descriptors bind a workload to the files that its producer actually measured.
import { readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
const [kind, metric, field='fps'] = process.argv.slice(2)
const digest = data => createHash('sha256').update(data).digest('hex')
function git(...args) {
  return execFileSync('git',args,{maxBuffer:128*1024*1024})
}
function sourceStamp() {
  const extra=git('ls-files','--others','--exclude-standard','-z').toString().split('\0').filter(Boolean).sort()
  return { commit:git('rev-parse','HEAD').toString().trim(), diff:digest(git('diff','--no-ext-diff','--binary','HEAD')),
    untracked:digest(JSON.stringify(extra.map(file=>[file,digest(lstatSync(file).isSymbolicLink()?readlinkSync(file):readFileSync(file))]))) }
}
function captureInput() {
  const file=process.env.ACTION_DRIVER_OPTIMIZE_CAPTURE
  if(!file)throw new Error('Set ACTION_DRIVER_OPTIMIZE_CAPTURE to a capture descriptor (see the installed profile’s probes/README.md)')
  const descriptor=JSON.parse(readFileSync(file))
  const source=sourceStamp()
  if(Object.keys(source).some(k=>source[k]!==descriptor.source?.[k]) || !descriptor.workload || !descriptor.environment)
    throw new Error('Capture source, workload or environment missing or stale')
  const input=descriptor[kind==='turn'?'turn':'loading']
  if(!input?.path || !input.sha256)throw new Error('Missing hashed input for '+kind)
  const bytes=readFileSync(resolve(dirname(file),input.path))
  if(digest(bytes)!==input.sha256)throw new Error('Capture content digest mismatch')
  return {bytes,workload:JSON.stringify([descriptor.workload,descriptor.environment,kind,metric]),input}
}
if(kind==='stamp'){console.log(JSON.stringify(sourceStamp()));process.exit(0)}
let workload,samples
if(kind==='media'){
  if(process.platform!=='linux')throw new Error('Requires a Linux desktop session and GStreamer')
  const data=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('pipeline_benchmark.py',import.meta.url)),metric],{encoding:'utf8'}))
  workload=JSON.stringify([metric,data.profile,data.dimensions,data.warmupSeconds,'25s',field])
  samples=[field==='gap-p95'?data.gapMs?.p95:data[field]]
}else{
  const capture=captureInput();workload=capture.workload
  if(kind==='turn'){
    const records=capture.bytes.toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
    const keys={ttft:'timeToFirstTokenMs',decode:'decodeTokensPerSecond','stream-block':'streamBlockMs',harness:'harnessOverheadMs'}
    if(metric==='cache-hit'||metric==='harness-ratio'){
      const [numer,denom]=metric==='cache-hit'?['cachedInputTokens','inputTokens']:['harnessOverheadMs','turnMs']
      const rows=records.filter(r=>Number.isFinite(r[numer])&&Number.isFinite(r[denom]))
      const total=rows.reduce((a,r)=>a+r[denom],0)
      samples=total>0?[rows.reduce((a,r)=>a+r[numer],0)/total]:[]
    }else samples=records.map(r=>r[keys[metric]]).filter(v=>v!=null)
  }else{
    const report=JSON.parse(capture.bytes)
    if(kind==='shell'){
      if(report.source?.commit!==sourceStamp().commit||!report.build?.provenance?.sha256||
        report.build.provenance.sha256!==capture.input.buildLogSha256)throw new Error('Missing matching build provenance')
      samples=[report.build.shellTotal[metric==='raw'?'rawBytes':'gzipBytes']]
    }else{
      const b=report.browser
      if(metric.startsWith('parser-'))samples=b.samples.map(s=>s.parser.find(p=>p.chars===(metric==='parser-10k'?10000:100000))?.p95Ms)
      else if(metric==='editor-reopen')samples=b.editorCycles.samples.map(s=>s.elapsedMs)
      else if(metric==='history-scroll')samples=b.history.samples.map(s=>s.scrollFrameMs)
      else{
        const cache=metric.endsWith('warm')?'warm':'disabled'
        samples=b.startup.samples.filter(s=>s.cache===cache).map(s=>metric.startsWith('first-editor')?s.firstEditorMs:s.observedReadyMs)
      }
    }
  }
}
if(!samples.length || samples.some(x=>!Number.isFinite(x)||x<0))throw new Error('Missing or invalid samples for '+kind+'/'+metric)
writeFileSync(process.env.ARCHITECTURE_KIT_MEASUREMENT,JSON.stringify({workload,samples}))
