/** Reject implicit platform fallbacks while respecting lexical shadowing. */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      fallback:
        'Inject the required environment dependency; do not silently fall back to a platform global.'
    }
  },
  create(context) {
    function isUnbound(name, node) {
      let scope = context.sourceCode.getScope(node)
      while (scope) {
        const variable = scope.set.get(name)
        if (variable?.defs.length) return false
        scope = scope.upper
      }
      return true
    }
    function platform(node) {
      if (!node) return false
      if (node.type === 'Identifier')
        return (
          ['fetch', 'setTimeout', 'setInterval', 'requestAnimationFrame'].includes(node.name) &&
          isUnbound(node.name, node)
        )
      if (node.type === 'CallExpression') return platform(node.callee)
      if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier')
        return false
      const owner = node.object.name
      return (
        isUnbound(owner, node) &&
        ((owner === 'Date' && node.property.name === 'now') ||
          (owner === 'Math' && node.property.name === 'random') ||
          (['globalThis', 'window'].includes(owner) &&
            ['fetch', 'setTimeout', 'setInterval', 'localStorage', 'sessionStorage'].includes(
              node.property.name
            )))
      )
    }
    function check(node) {
      if (platform(node.right)) context.report({ node: node.right, messageId: 'fallback' })
    }
    return {
      LogicalExpression(node) {
        if (['??', '||'].includes(node.operator)) check(node)
      },
      AssignmentPattern: check
    }
  }
}
