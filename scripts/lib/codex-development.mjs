import { join } from 'node:path'

const begin = '# BEGIN ARCHITECTURE-KIT CODEX'
const end = '# END ARCHITECTURE-KIT CODEX'

export function mergeManagedConfig(existing, body) {
  const start = existing.indexOf(begin), finish = existing.indexOf(end)
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) throw new Error('incomplete managed config block')
  const block = `${begin}\n${body.trim()}\n${end}`
  if (start < 0) return `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${block}\n`
  return existing.slice(0, start) + block + existing.slice(finish + end.length)
}

export function renderConfig(policy, root, serena) {
  const q = JSON.stringify
  return [
    '[mcp_servers.serena]', `command = ${q(serena)}`, `cwd = ${q(root)}`,
    `args = ${q(['start-mcp-server', '--context', join(root, '.serena/context.yml'), '--mode', join(root, '.serena/mode.yml'), '--agent-interface', 'tools', '--project', root, '--enable-web-dashboard', 'true', '--open-web-dashboard', 'false'])}`,
    `enabled_tools = ${q(policy.serenaTools)}`, 'startup_timeout_sec = 60', 'tool_timeout_sec = 60', '',
  ].join('\n')
}

// Dependencies are supplied by the CLI composition root; tests never spawn real processes.
export async function captureCommand(argv, { run, write }) {
  const original = await run(argv[0], argv.slice(1))
  await write('stdout.log', original.stdout)
  await write('stderr.log', original.stderr)
  const compressed = await run('rtk', ['pipe'], `${original.stdout}\n${original.stderr}`)
  await write('summary.log', compressed.stdout)
  await write('compression.stderr.log', compressed.stderr)
  const result = { command: argv, code: original.code, signal: original.signal, compressionCode: compressed.code }
  await write('result.json', JSON.stringify(result, null, 2) + '\n')
  return result
}
