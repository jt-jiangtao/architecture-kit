import {
  mkdir,
  readFile,
  lstat,
  writeFile,
  link,
  rm,
  rename,
  symlink,
  readlink,
  realpath
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export async function installRepairSkill(
  project: string,
  update: boolean,
  name: string = 'cleanup-repair'
) {
  if (!['cleanup-repair', 'optimize-repair'].includes(name))
    throw new Error('Unknown maintenance skill')
  const root = await realpath(project)
  let dir = root
  for (const part of ['.agents', 'skills', name]) {
    dir = join(dir, part)
    try {
      await mkdir(dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    if (!(await lstat(dir)).isDirectory())
      throw new Error('Skill directory must be a real directory: ' + dir)
  }
  const file = join(dir, 'SKILL.md'),
    lock = join(dir, '.installing')
  const body = await readFile(
    new URL('../../../../skills/' + name + '/SKILL.md', import.meta.url),
    'utf8'
  )
  const payload = body.trimEnd() + '\n',
    text =
      payload +
      '\n<!-- architecture-kit managed sha256=' +
      hash(payload) +
      ' -->\n'
  await mkdir(lock)
  const temp = resolve(dir, '.update-' + randomUUID())
  try {
    let previous: string | null = null
    try {
      if (!(await lstat(file)).isFile())
        throw new Error('Expected a regular SKILL.md')
      previous = await readFile(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    async function discover() {
      let directory = root
      for (const part of ['.claude', 'skills']) {
        directory = join(directory, part)
        try {
          await mkdir(directory)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        }
        if (!(await lstat(directory)).isDirectory())
          throw new Error('Invalid skill discovery directory')
      }
      const dest = join(directory, name),
        source = '../../.agents/skills/' + name
      try {
        await symlink(source, dest, 'dir')
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readlink(dest)) !== source
        )
          throw new Error('Conflicting Claude skill entry: ' + dest)
      }
      return file
    }
    if (previous === text) return await discover()
    if (previous !== null) {
      if (!update) throw new Error('Skill exists; use skill update ' + name)
      const match =
        /^([\s\S]*)\n<!-- architecture-kit managed sha256=([a-f0-9]{64}) -->\n$/.exec(
          previous
        )
      if (!match || hash(match[1]!) !== match[2])
        throw new Error(
          'Locally edited or unmanaged skill; review your changes first'
        )
    } else if (update) throw new Error('Skill missing; use skill add ' + name)
    await writeFile(temp, text, { flag: 'wx' })
    await discover()
    if (previous === null) await link(temp, file)
    else await rename(temp, file)
    return file
  } finally {
    await rm(temp, { force: true })
    await rm(lock, { recursive: true })
  }
}
