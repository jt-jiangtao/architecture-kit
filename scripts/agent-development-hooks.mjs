#!/usr/bin/env node
const mode = process.argv[2]
let raw = ''
for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)

function emit(event, context) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context
    }
  }))
}

const sessionContext = [
  'Architecture Kit development tool routing:',
  '1. Serena first for source symbols, references, diagnostics, renaming, and structural edits.',
  '2. Context7 first for external package/framework API and version-specific documentation; verify against local types.',
  '3. Ripwire before multi-file changes, regression work, test selection, or stack-trace investigation; it complements Serena.',
  '4. Semgrep before claiming security-sensitive code complete.',
  '5. ego-browser first for ordinary browser work. If it is unavailable or fails, or raw UI/performance/network/trace work is needed, use $playwright-cli.',
  '6. RTK may compress output, but final claims must use original logs, exit codes, and files.',
  'Do not claim a tool ran unless it actually ran. If one is missing, use pnpm agent-tools:install <tool>.'
].join('\n')

if (mode === 'session') {
  emit('SessionStart', sessionContext)
} else if (mode === 'prompt') {
  const prompt = String(input.prompt ?? '').toLowerCase()
  const routes = []
  if (/\b(?:api|library|framework|package|sdk|dependency|migration|docs?)\b|文档|依赖|版本|迁移/i.test(prompt)) {
    routes.push('Context7: resolve the installed version and query external docs before answering or editing.')
  }
  if (/\b(?:symbol|reference|definition|diagnostic|typescript|refactor)\b|符号|引用|定义|诊断|重构|结构编辑/i.test(prompt)) {
    routes.push('Serena: load initial_instructions, then use symbol/reference/diagnostic tools before broad shell search.')
  }
  if (/\b(?:bug|fix|change|impact|regression|test|refactor|implementation)\b|修复|修改|影响|回归|测试|重构|实现|调用/i.test(prompt)) {
    routes.push('Ripwire: use pnpm ripwire-project with --situ, --for, --impact, --affected, or --from-trace to establish scope and tests before broad edits.')
  }
  if (/\b(?:security|secret|credential|auth|permission|shell|network|mcp|plugin)\b|安全|凭据|权限|命令执行|路径穿越|网络|插件/i.test(prompt)) {
    routes.push('Semgrep: scan relevant changed or sensitive paths and report findings before claiming completion.')
  }
  if (/\b(?:ui|browser|button|screenshot|renderer|playwright|ego|interface|performance)\b|界面|按钮|页面|截图|浏览器|性能/i.test(prompt)) {
    routes.push('Browser: prefer ego-browser; use $playwright-cli only when ego fails/is unavailable or deeper UI, console, network, trace, or performance inspection is required.')
  }
  if (routes.length) emit('UserPromptSubmit', `Required tool routing for this turn:\n- ${routes.join('\n- ')}`)
} else if (mode === 'post-bash') {
  // Compatibility for a project hook already loaded by a running Codex session.
  // Emit nothing: DeepSeek strict Responses rejects messages between function calls and outputs.
} else {
  console.error('Usage: node scripts/agent-development-hooks.mjs <session|prompt|post-bash>')
  process.exitCode = 2
}
