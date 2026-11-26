import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const EXCLUDED_PREFIXES = [
  'thirdparty/',
  'evals/',
  'artifacts/test-reports/',
  'docs/testing/'
]

const TEST_FILE_PATTERNS = [
  /(?:^|\/)(?:__tests__|tests)\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(?:^|\/)test_[^/]+\.py$/,
  /_test\.py$/
]

const TEST_RUNNER_PATTERNS = [
  /\b(?:vitest|jest|pytest|mocha|ava)\b/,
  /\bgo\s+test\b/,
  /\bplaywright\s+test\b/,
  /\bpnpm\s+(?:test|agent:verify)\b/
]

const MOCK_ABUSE_PATTERN = /\b(?:vi|jest)\.mock\s*\(|MagicMock|unittest\.mock\b/

const EDIT_TOOL_NAMES = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'write_file',
  'edit_file',
  'apply_patch',
  'create_text_file',
  'replace_content',
  'replace_in_files',
  'replace_lines',
  'insert_at_line',
  'delete_lines'
])

const NON_RUNNER_PROGRAMS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'echo',
  'printf',
  'cat',
  'head',
  'tail'
])

function normalizeRepoPath(root: string, rawPath: unknown): string {
  if (!rawPath || typeof rawPath !== 'string') return ''
  const trimmed = rawPath.trim().replaceAll('\\', '/')
  if (!trimmed) return ''
  let normalized = trimmed
  if (isAbsolute(trimmed)) {
    const rel = relative(root, resolve(trimmed)).replaceAll('\\', '/')
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) normalized = rel
  }
  return normalized.replace(/^\.\//, '')
}

function isTestFilePath(root: string, rawPath: unknown): boolean {
  const p = normalizeRepoPath(root, rawPath)
  if (!p) return false
  if (EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix))) return false
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(p))
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote = ''
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    const next = command[i + 1] ?? ''
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      current += ch
      escaped = true
      continue
    }
    if (!quote && (ch === "'" || ch === '"')) {
      quote = ch
      current += ch
      continue
    }
    if (quote && ch === quote) {
      quote = ''
      current += ch
      continue
    }
    if (!quote && (ch === ';' || ch === '\n' || (ch === '&' && next === '&') || (ch === '|' && next === '|') || ch === '|')) {
      if (current.trim()) segments.push(current.trim())
      current = ''
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i += 1
      continue
    }
    current += ch
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function isTestRunnerCommand(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    const first = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
    if (!first || NON_RUNNER_PROGRAMS.has(first)) continue
    if (TEST_RUNNER_PATTERNS.some((pattern) => pattern.test(segment))) return true
  }
  return false
}

function extractCandidatePaths(toolInput: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const key of ['file_path', 'filePath', 'path', 'Path', 'target_file', 'TargetFile', 'notebook_path']) {
    if (typeof toolInput[key] === 'string') paths.push(toolInput[key] as string)
  }
  if (typeof toolInput.patch === 'string') {
    for (const match of (toolInput.patch as string).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      if (match[1]) paths.push(match[1].trim())
    }
  }
  return paths
}

function extractWrittenText(toolInput: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['content', 'Content', 'new_string', 'Replacement', 'patch', 'input']) {
    if (typeof toolInput[key] === 'string') parts.push(toolInput[key] as string)
  }
  if (Array.isArray(toolInput.edits)) {
    for (const item of toolInput.edits as Array<{ new_string?: unknown }>) {
      if (item && typeof item.new_string === 'string') parts.push(item.new_string)
    }
  }
  return parts.join('\n')
}

function blockReason(reason: string): string {
  return (
    `已拦截未经授权的测试文件写入或测试执行（${reason}）。\n` +
    '当前项目采用「反垃圾测试四层验证体系」，默认禁止新增、修改或运行单元测试/TDD。' +
    '请改用 L1 静态门禁（pnpm typecheck / pnpm lint / pnpm validate:config / pnpm check:visual-tokens）' +
    '与 L3 真实运行态验证（Ego Lite / Electron / Docker）。\n' +
    '若已获用户针对本次范围的单独明确批准编写 L2 契约或社交型集成测试，请设置环境变量 ACTION_DRIVER_ALLOW_TESTS=1 后重试。'
  )
}

export function runTestGuard(root: string, mode: 'check' | 'hook'): number {
  const allowTests = process.env.ACTION_DRIVER_ALLOW_TESTS === '1'
  if (mode === 'hook') {
    const raw = readFileSync(0, 'utf8').trim()
    if (!raw) return 0
    const event = JSON.parse(raw) as Record<string, unknown>
    const toolName = String(event.tool_name ?? event.toolName ?? '').trim()
    const normalizedTool = toolName.toLowerCase()
    const toolInput = ((event.tool_input ?? event.toolInput ?? {}) as Record<string, unknown>)

    const isBash =
      normalizedTool === 'bash' ||
      (!normalizedTool && (typeof toolInput.command === 'string' || typeof toolInput.cmd === 'string'))

    if (isBash) {
      const command = String(toolInput.command ?? toolInput.cmd ?? '')
      if (!allowTests && isTestRunnerCommand(command)) {
        console.error(blockReason(`命令行命中测试运行器: ${command.trim()}`))
        return 2
      }
      return 0
    }

    if (normalizedTool && !EDIT_TOOL_NAMES.has(normalizedTool)) return 0
    const matchedTestPaths = extractCandidatePaths(toolInput).filter((p) => isTestFilePath(root, p))
    if (!matchedTestPaths.length) return 0

    if (!allowTests) {
      console.error(blockReason(`目标路径属于测试文件: ${matchedTestPaths.join(', ')}`))
      return 2
    }

    const written = extractWrittenText(toolInput)
    if (MOCK_ABUSE_PATTERN.test(written)) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext:
              '反垃圾测试提醒：检测到写入内容包含 vi.mock / jest.mock / MagicMock。按 L2 契约与社交型集成测试规范，禁止 mock 内部模块或验证实现细节，只允许在外部 I/O 边界使用显式注入替身或内存 Fake。'
          }
        })
      )
    }
    return 0
  }

  const candidates = new Set<string>()
  for (const args of [
    ['diff', 'HEAD', '--name-only', '-z', '--diff-filter=ACMR'],
    ['ls-files', '--others', '--exclude-standard', '-z']
  ]) {
    const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    for (const item of stdout.split('\0')) {
      if (item && isTestFilePath(root, item)) candidates.add(item)
    }
  }
  const files = [...candidates].sort()
  if (!files.length) {
    console.log(JSON.stringify({ ok: true, files: [] }))
    return 0
  }
  if (!allowTests) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          files,
          message:
            '发现未经批准的测试文件改动；如已获用户单独批准，请携带 ACTION_DRIVER_ALLOW_TESTS=1 运行以进行 L2 契约审查。'
        },
        null,
        2
      )
    )
    return 1
  }
  const mockWarnings: Array<{ file: string; warning: string }> = []
  for (const file of files) {
    const abs = resolve(root, file)
    if (!existsSync(abs)) continue
    if (MOCK_ABUSE_PATTERN.test(readFileSync(abs, 'utf8'))) {
      mockWarnings.push({
        file,
        warning: '检测到 vi.mock / jest.mock / MagicMock，请核对是否仅在外部 I/O 边界使用内存 Fake/替身。'
      })
    }
  }
  console.log(JSON.stringify({ ok: true, allowed: true, files, mockWarnings }))
  return 0
}
