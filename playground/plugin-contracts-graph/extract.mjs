import path from 'node:path';
import { Application, OptionDefaults } from 'typedoc';

export const revision = '18dc6c3cd210343c7e741169038d5259c2932a50';
export const blob = 'https://github.com/jt-jiangtao/action-driver/blob/' + revision + '/';

export async function extract(root) {
  const pkg = path.join(root, 'packages/plugin-contracts');
  const app = await Application.bootstrap({
    entryPoints: [path.join(pkg, 'src/index.ts')],
    tsconfig: path.join(pkg, 'tsconfig.build.json'),
    basePath: root,
    blockTags: [...OptionDefaults.blockTags, '@architecture'],
    disableGit: true,
    sourceLinkTemplate: blob + '{path}#L{line}',
  });
  const project = await app.convert();
  if (!project || app.logger.hasErrors()) throw Error('TypeDoc conversion failed');
  return app.serializer.projectToObject(project, root);
}
