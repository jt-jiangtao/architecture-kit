import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverModules } from '../dist/packages/config/src/discover.js'

test('discover only opted-in workspace owners, resolving conditional root exports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'named-inputs-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  await writeFile(join(root,'pnpm-workspace.yaml'),"packages: ['packages/*','!packages/excluded']")
  for (const name of ['docs','tags','plain','excluded','plain/nested']) {
    const dir = join(root,'packages',name)
    await mkdir(dir,{recursive:true})
    await writeFile(join(dir,'package.json'),JSON.stringify({name,exports:{'.':{types:'./index.ts'}}}))
    await writeFile(join(dir,'index.ts'), name==='tags' ? '/** @architecture sample Sample */\nexport function f(){}' : 'export const sample = "@architecture sample"')
    await writeFile(join(dir,'tsconfig.json'),'{}')
    if (['docs','excluded','plain/nested'].includes(name)) await writeFile(join(dir,'read.architecture-kit.md'),'# Hi')
  }
  const discover=()=>discoverModules(root,'.store',async p=>p)
  const entries=await discover()
  assert.deepEqual(entries.map(e=>e.entry),['packages/docs/index.ts','packages/tags/index.ts'])
  assert.deepEqual(entries[0].documents,['packages/docs/read.architecture-kit.md'])
  await writeFile(join(root,'packages/docs/package.json'),'{"name":"docs","exports":"./missing.js"}')
  await assert.rejects(discover,/docs.*exports.*missing.js/)
})
