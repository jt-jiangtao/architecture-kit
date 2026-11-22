interface RuleNode {
  type: string
  name?: string
  operator?: string
  computed?: boolean
  object?: RuleNode
  property?: RuleNode
  callee?: RuleNode
  right?: RuleNode
}

interface VariableRecord {
  defs: unknown[]
}

interface ScopeRecord {
  set: Map<string, VariableRecord>
  upper: ScopeRecord | null
}

interface RuleContext {
  sourceCode: { getScope(node: RuleNode): ScopeRecord }
  report(descriptor: { node: RuleNode; messageId: string }): void
}

/** Reject implicit platform fallbacks while respecting lexical shadowing. */
export const noGlobalFallbackRule = {
  meta: {
    type: 'problem' as const,
    schema: [],
    messages: {
      fallback:
        'Inject the required environment dependency; do not silently fall back to a platform global.'
    }
  },
  create(context: RuleContext) {
    function isUnbound(name: string, node: RuleNode): boolean {
      let scope: ScopeRecord | null = context.sourceCode.getScope(node)
      while (scope) {
        const variable = scope.set.get(name)
        if (variable?.defs.length) return false
        scope = scope.upper
      }
      return true
    }
    function platform(node: RuleNode | undefined): boolean {
      if (!node) return false
      if (node.type === 'Identifier') {
        return (
          Boolean(node.name) &&
          ['fetch', 'setTimeout', 'setInterval', 'requestAnimationFrame'].includes(node.name!) &&
          isUnbound(node.name!, node)
        )
      }
      if (node.type === 'CallExpression') return platform(node.callee)
      if (
        node.type !== 'MemberExpression' ||
        node.computed ||
        node.object?.type !== 'Identifier' ||
        !node.object.name ||
        !node.property?.name
      ) {
        return false
      }
      const owner = node.object.name
      const prop = node.property.name
      return (
        isUnbound(owner, node) &&
        ((owner === 'Date' && prop === 'now') ||
          (owner === 'Math' && prop === 'random') ||
          (['globalThis', 'window'].includes(owner) &&
            ['fetch', 'setTimeout', 'setInterval', 'localStorage', 'sessionStorage'].includes(prop)))
      )
    }
    function check(node: RuleNode) {
      if (platform(node.right)) context.report({ node: node.right!, messageId: 'fallback' })
    }
    return {
      LogicalExpression(node: RuleNode) {
        if (node.operator === '??' || node.operator === '||') check(node)
      },
      AssignmentPattern: check
    }
  }
}

export default noGlobalFallbackRule
