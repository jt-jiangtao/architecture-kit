const application = '^apps/local-runtime/src/application/'
const client = '^packages/session-client/src/'
const hooks =
  '^apps/desktop/src/renderer/src/hooks/(use-plugin-contributions|plugin-contribution-query)\\.ts$'
module.exports = {
  forbidden: [
    { name: 'workspace-no-cycles', severity: 'error', from: { path: '^(apps|packages|plugins)/[^/]+/src/' }, to: { circular: true } },
    {
      name: 'application-no-composition',
      severity: 'error',
      from: { path: `${application}(?!index\\.ts$|context\\.ts$)` },
      to: {
        path: '^apps/local-runtime/src/composition/'
      }
    },
    {
      name: 'application-no-transport',
      severity: 'error',
      from: { path: application },
      to: { path: '^apps/local-runtime/src/(transport|entrypoints|hosts|local-runtime-server)(/|\\.)' }
    },
    {
      name: 'stream-internals-no-facade',
      severity: 'error',
      from: {
        path: `${client}(stream-connection|connection-lifecycle|request-registry|stream-event-sequencer)\\.ts$`
      },
      to: { path: `${client}(renderer-stream-client|index)\\.ts$` }
    },
    {
      name: 'client-no-host',
      severity: 'error',
      from: { path: client },
      to: {
        path: '^(apps/|node:|electron$|@action-driver/(agent-runtime|runtime-storage))|node_modules/(electron|@action-driver/(agent-runtime|runtime-storage))/'
      }
    },
    {
      name: 'query-no-local-cache-owner',
      severity: 'error',
      from: { path: hooks },
      to: { path: '^apps/(local-runtime|desktop/src/(main|preload))/' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|out|vendor|thirdparty)/|^apps/mobile/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      conditionNames: ['import', 'default', 'node']
    }
  }
}
