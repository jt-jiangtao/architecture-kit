import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { cpus, platform, release } from 'node:os'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

export function summarizeSamples(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Expected nonempty finite nonnegative timing samples')
  const sorted = [...values].sort((a, b) => a - b)
  return { count: values.length, median: sorted[Math.ceil(sorted.length / 2) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) }
}

// CLI composition root: the browser owns measurement; this command preserves its samples and build provenance.
async function main() {
  const [sampleFile, outputFile, buildLog] = process.argv.slice(2)
  if (!sampleFile || !outputFile) throw new Error('Usage: architecture-kit optimize capture -- loading <browser-samples.json> <artifacts/report.json> [build-log]')
  const root = process.cwd()
  const output = resolve(outputFile)
  if (!output.startsWith(resolve(root, 'artifacts') + '/')) throw new Error('Performance reports must be written under artifacts/')
  const browser = JSON.parse(await readFile(sampleFile, 'utf8'))
  const buildPath = resolve(root, 'apps/desktop/out/renderer/lazy-loading-report.json')
  const build = JSON.parse(await readFile(buildPath, 'utf8'))
  const shellChunks = await Promise.all(build.shellChunks.map(async chunk => {
    const bytes = await readFile(resolve(dirname(buildPath), chunk.file))
    return { file: chunk.file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length }
  }))
  const report = {
    measuredAt: new Date().toISOString(),
    source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      worktree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }) },
    environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model },
    build: { reportModifiedAt: (await stat(buildPath)).mtime.toISOString(),
      provenance: buildLog ? { suppliedBuildLog: buildLog, sha256: createHash('sha256').update(await readFile(buildLog)).digest('hex') }
        : 'Existing output; not asserted to match current worktree', shellChunks,
      shellTotal: shellChunks.reduce((total, chunk) => ({ rawBytes: total.rawBytes + chunk.rawBytes, gzipBytes: total.gzipBytes + chunk.gzipBytes }), { rawBytes: 0, gzipBytes: 0 }) },
    browser,
    parser: [10000, 100000].map(chars => ({ chars,
      perRunP95: summarizeSamples(browser.samples.map(sample => sample.parser.find(item => item.chars === chars).p95Ms)) })),
    fixtureStartup: browser.startup ? ['disabled', 'warm'].map(cache => {
      const samples = browser.startup.samples.filter(sample => sample.cache === cache)
      return { cache, observedReadyMs: summarizeSamples(samples.map(sample => sample.observedReadyMs)),
        firstEditorMs: summarizeSamples(samples.map(sample => sample.firstEditorMs)) }
    }) : 'Not collected',
    editorReopenMs: browser.editorCycles ? summarizeSamples(browser.editorCycles.samples.map(sample => sample.elapsedMs)) : 'Not collected',
    historyScrollFramesMs: browser.history ? summarizeSamples(browser.history.samples.map(sample => sample.scrollFrameMs)) : 'Not collected',
    conclusion: 'Component fixture timings only; no full-application startup, INP, or improvement claim. Build provenance is separate from browser timing evidence.'
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(output)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
