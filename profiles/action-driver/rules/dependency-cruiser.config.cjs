const { builtinModules } = require('node:module')
const client = '^packages/communication/app-client/src/'
const builtins = builtinModules.map((name) => name.replaceAll('.', '\\.')).join('|')
const host = `^(node:|(${builtins})$|electron(/|$)|apps/|packages/agent/(runtime|runtime-storage)/|@action-driver/(agent-runtime|runtime-storage)(/|$))|node_modules/(electron|@action-driver/(agent-runtime|runtime-storage))(/|$)`
module.exports = {
  forbidden: [
    {
      name: 'workspace-no-cycles',
      severity: 'error',
      from: { path: '^(?:(?:apps|plugins)/[^/]+/src/|packages/.+/src/)' },
      to: { circular: true }
    },
    {
      name: 'stream-internals-no-facade',
      severity: 'error',
      from: {
        path: `${client}(stream-connection|connection-lifecycle|request-registry|stream-event-sequencer|conversation-requests|conversation-projection)\\.ts$`
      },
      to: { path: `${client}(renderer-stream-client|conversation|index)\\.ts$` }
    },
    {
      name: 'client-no-host',
      severity: 'error',
      from: { path: client },
      to: {
        path: host
      }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(dist|out|vendor|thirdparty)/|^apps/mobile/|^packages/ui/workbench/ui/src/review/pdf-worker\\.mjs$'
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      conditionNames: ['import', 'default', 'node']
    }
  }
}
