/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Workspace packages and applications must form an acyclic dependency graph.',
      from: { path: '^(packages|apps)/' },
      to: { circular: true }
    },
    {
      name: 'packages-never-depend-on-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' }
    },
    {
      name: 'core-ir-pure',
      severity: 'error',
      from: { path: '^packages/core-ir/src/' },
      to: {
        dependencyTypes: ['core']
      }
    },
    {
      name: 'core-ir-no-workspace-deps',
      severity: 'error',
      from: { path: '^packages/core-ir/src/' },
      to: { path: '^packages/(?!core-ir/)' }
    },
    {
      name: 'ports-pure',
      severity: 'error',
      from: { path: '^packages/ports/src/' },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'ports-only-core-ir',
      severity: 'error',
      from: { path: '^packages/ports/src/' },
      to: { path: '^packages/(?!core-ir/|ports/)' }
    },
    {
      name: 'flows-only-core-ir-and-ports',
      severity: 'error',
      from: { path: '^packages/flow-[^/]+/src/' },
      to: {
        path: '^packages/(?!core-ir/|ports/|flow-)'
      }
    },
    {
      name: 'flows-only-node-crypto',
      severity: 'error',
      from: { path: '^packages/flow-[^/]+/src/' },
      to: {
        dependencyTypes: ['core'],
        pathNot: ['^node:crypto$', '^crypto$']
      }
    },
    {
      name: 'config-no-analyzers-or-profile',
      severity: 'error',
      from: { path: '^packages/config/src/' },
      to: { path: '^(packages/(analyzers|renderers|profile-action-driver)/|profiles/)' }
    },
    {
      name: 'renderers-no-parsers',
      severity: 'error',
      from: { path: '^packages/renderers/src/' },
      to: { path: '(node_modules/(typescript|likec4)/|^packages/analyzers/)' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'node', 'default']
    }
  }
}
