import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import ts from 'typescript'
import { parse } from 'yaml'
import { compilerOutputs, inputPaths, visitExports, workspaceMember } from '../../adapters/src/workspace.js'
import type { ScanEntry } from './index.js'

const marker = /\.architecture-kit\.(?:md|c4|likec4)$/
const source = /\.[cm]?tsx?$/
export async function discoverModules(root: string, storage: string, input: (p:string, label:string)=>Promise<string>): Promise<ScanEntry[]> {
  root = await realpath(root)
  const workspace = 'pnpm-workspace.yaml'
  if (!(await stat(join(root,workspace)).catch(()=>null))?.isFile()) return []
  const member = workspaceMember(parse(await readFile(join(root,await input(workspace,'workspace')),'utf8')))
  const files = await inputPaths(root,storage)
  const manifests = new Set(files.filter(f=>basename(f)==='package.json').map(dirname))
  const packages = new Map<string,{documents:string[], sources:string[], annotated:boolean}>()
  for (const file of files) {
    if (!marker.test(file) && !source.test(file)) continue
    let dir = dirname(file)
    while (!manifests.has(dir) && dir!=='.') dir=dirname(dir)
    if (!manifests.has(dir) || !member(dir)) continue
    const disk=join(root,file)
    if (await realpath(disk).catch(()=>null)!==disk) continue
    let pkg=packages.get(dir)
    if (!pkg) packages.set(dir,pkg={documents:[],sources:[],annotated:false})
    if (marker.test(file)) pkg.documents.push(file)
    else {
      pkg.sources.push(file)
      if (pkg.annotated || pkg.documents.length) continue
      const text=await readFile(disk,'utf8')
      if (!text.includes('@architecture')) continue
      const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true)
      pkg.annotated=sf.statements.some(node=>ts.getJSDocTags(node).some(tag=>tag.tagName.text==='architecture') && ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))
    }
  }
  const entries:ScanEntry[]=[]
  const available=new Set(files)
  for (const dir of [...packages.keys()].sort()) {
    const pkg=packages.get(dir)!
    if (!pkg.annotated && !pkg.documents.length) continue
    const manifest=await input(join(dir,'package.json'),'manifest')
    const data=JSON.parse(await readFile(join(root,manifest),'utf8'))
    const targets:string[]=[]
    visitExports(data.exports,(target,subpath)=>{if(subpath==='.') targets.push(target)})
    const outputs=compilerOutputs(root,dir,data,available)
    const candidates=new Set(targets.filter(t=>t.startsWith('./')).map(t=>join(dir,t)).map(t=>outputs.get(t)??t).filter(t=>pkg.sources.includes(t) && !/\.d\.[cm]?ts$/.test(t)))
    if(candidates.size!==1) throw Error(data.name+' exports["."] must resolve to one TypeScript source: '+targets.join(', '))
    entries.push({manifest,entry:await input([...candidates][0]!,'entry'),tsconfig:await input(join(dir,'tsconfig.json'),'tsconfig'),documents: await Promise.all(pkg.documents.map(f=>input(f,'document'))),sources:pkg.sources})
  }
  return entries
}
