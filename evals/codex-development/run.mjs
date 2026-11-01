import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cases = JSON.parse(await readFile(new URL('cases.json', import.meta.url), 'utf8'))
const args = process.argv.slice(2)
const selected = args.includes('--case') ? args[args.indexOf('--case') + 1] : null
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : null
const chosen = cases.filter(item => !selected || item.id === selected)
if (!chosen.length) throw new Error('Unknown case')
const output = join(root, 'artifacts/evals/codex-development', `${Date.now()}-${process.pid}`)
await mkdir(output, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')

async function run(command, argv, cwd, prefix, input) {
  const start = Date.now()
  const child = spawn(command, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 300000)
  child.stdin.end(input)
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timeout))
  await writeFile(prefix + '.jsonl', stdout)
  await writeFile(prefix + '.stderr.log', stderr)
  return { ...status, timedOut, milliseconds: Date.now() - start, stdout }
}

const report = {
  codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  nodeVersion: process.version, requestedModel: model ?? 'host-default',
  casesHash: hash(JSON.stringify(cases)), policyHash: hash(await readFile(join(root, 'config/agent-development/policy.json'))),
  actualModel: 'not-reported-by-host', results: [],
  interpretation: '任务级行为冒烟，不代表相对基线的质量或效率提升。语义审查与人工打断指标需阅读原始输出后评分。',
}
for (const item of chosen) {
  const directory = join(output, item.id), workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  const guidance = '本目录是一次性开发 Agent 评估样例。只操作用户指定文件；不访问外部服务或父目录业务文件，不创建工作树、不提交、不委派子 Agent。所有写入仅限本样例目录。运行 node check.mjs 是本次已授权定向验证。遵循当前请求的只读/实施边界，不把技能默认流程当成额外确认要求。\n'
  const seed = { ...item.files, 'AGENTS.md': guidance }
  for (const [name, body] of Object.entries(seed)) await writeFile(join(workspace, name), body)
  console.log(`Running ${item.id}: ${workspace}`)
  const execution = await run('codex', ['exec', '--ephemeral', '--json', '--strict-config', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', workspace,
    '-c', 'mcp_servers.serena.enabled=false', ...(model ? ['--model', model] : []), '-'], workspace, join(directory, 'agent'), item.prompt)
  const changed = []
  for (const name of await readdir(workspace)) {
    if (!(name in seed) || hash(await readFile(join(workspace, name)).catch(() => Buffer.from('directory'))) !== hash(seed[name])) changed.push(name)
  }
  for (const name of Object.keys(seed)) {
    try { await readFile(join(workspace, name)) } catch { if (!changed.includes(name)) changed.push(name) }
  }
  const violations = changed.filter(name => !item.allowedChanges.includes(name))
  // Restore the original oracle before independent execution: an edited test can never grant a pass.
  if (item.files['check.mjs']) await writeFile(join(workspace, 'check.mjs'), item.files['check.mjs'])
  const check = item.files['check.mjs'] ? await run(process.execPath, ['check.mjs'], workspace, join(directory, 'oracle')) : null
  const events = execution.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const usage = events.filter(event => event.type === 'turn.completed').map(event => event.usage)
  const lastMessages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item.text)
  const result = { id: item.id, exitCode: execution.code, timedOut: execution.timedOut, milliseconds: execution.milliseconds,
    changed, violations, oracleExitCode: check?.code ?? null, usage, lastMessages,
    behaviorPassed: execution.code === 0 && !execution.timedOut && violations.length === 0 && (check === null || check.code === 0),
    semanticReview: 'unscored', interruptions: 'unmeasured', rework: 'unmeasured' }
  report.results.push(result)
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ id: item.id, passed: result.behaviorPassed, milliseconds: result.milliseconds }))
}
console.log(`Report: ${join(output, 'report.json')}`)
if (report.results.some(result => !result.behaviorPassed)) process.exitCode = 1
