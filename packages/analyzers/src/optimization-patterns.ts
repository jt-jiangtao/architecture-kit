import ts from 'typescript'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { OptimizeTask } from '@architecture-kit/ports'

export async function discoverPatterns(
  root: string,
  roots: string[],
  storage: string,
  signal: AbortSignal
) {
  const paths = await promisify(execFile)(
    'git',
    [
      '--literal-pathspecs',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...roots
    ],
    { cwd: root, signal, maxBuffer: 32 * 1024 * 1024 }
  )
  const tasks = new Map<string, OptimizeTask>()
  for (const file of [...new Set(paths.stdout.split('\0'))].sort()) {
    signal.throwIfAborted()
    if (
      !/\.[cm]?[jt]sx?$/.test(file) ||
      /(?:^|\/)(?:node_modules|dist|out|vendor|tests?|fixtures|__tests__)(?:\/|$)|\.(?:spec|test|d)\.[cm]?[jt]sx?$/.test(
        file
      )
    )
      continue
    const path = resolve(root, file)
    if (path.startsWith(resolve(root, storage) + sep)) continue
    const canonical = await realpath(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
    if (canonical !== path) continue
    const source = ts.createSourceFile(file, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
    function add(node: ts.Node, rule: string, hypothesis: string) {
      const anchor = node.getText(source)
      const id =
        'pattern-' +
        createHash('sha256')
          .update(JSON.stringify([rule, file, anchor]))
          .digest('hex')
          .slice(0, 24)
      if (tasks.has(id)) return
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      tasks.set(id, {
        id,
        kind: 'review',
        target: file,
        title: rule + ' · line ' + line,
        hypothesis: hypothesis + '。定位：' + anchor.slice(0, 120).replace(/\s+/g, ' '),
        inputs: [],
        check: null
      })
    }
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['map', 'filter', 'forEach', 'some', 'every'].includes(node.expression.name.text)
      ) {
        const cb = node.arguments[0]
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const inner = (n: ts.Node) => {
            if (ts.isFunctionLike(n)) return
            if (
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              ts.isIdentifier(n.expression.expression) &&
              ['find', 'includes', 'indexOf'].includes(n.expression.name.text)
            )
              add(
                node,
                '循环内查找',
                '核对两侧数据规模、顺序及匹配语义，再判断能否跨迭代复用索引'
              )
            ts.forEachChild(n, inner)
          }
          inner(cb.body)
        }
      }
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression?.getText(source) === '0' &&
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === 'sort'
      )
        add(node, '排序后只取首项', '核对排序副作用、比较器、空值和并列项，再判断是否只需单遍选择')
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...tasks.values()]
}
