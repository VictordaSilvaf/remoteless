import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { resolve } from 'node:path';

const alias = Object.fromEntries(['contracts', 'crypto', 'database'].map(name => [`@msm/${name}`, resolve(`packages/${name}/src/index.ts`)]));
for (const name of ['local-api', 'group-runner','session-lab']) {
  await build({entryPoints: [`apps/${name}/src/index.ts`], outfile: `apps/${name}/dist/index.js`, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias, sourcemap: true, target: 'node22'});
}
await build({entryPoints:['apps/session-lab/src/verify.ts'],outfile:'apps/session-lab/dist/verify.js',bundle:true,platform:'node',format:'esm',packages:'external',alias,target:'node22'});
await build({entryPoints:['apps/session-lab/src/electron-verify.ts'],outfile:'apps/session-lab/dist/electron-verify.js',bundle:true,platform:'node',format:'esm',packages:'external',alias,target:'node22'});
await build({entryPoints: ['scripts/migrate.ts'], outfile: 'scripts/dist/migrate.js', bundle: true, platform: 'node', format: 'esm', packages: 'external', alias, target: 'node22'});
for (const name of ['foundation-container','foundation-electron']) {
  await build({entryPoints:[`scripts/${name}.ts`],outfile:`scripts/dist/${name}.js`,bundle:true,platform:'node',format:'esm',packages:'external',alias,target:'node22'});
}
await build({entryPoints:['tests/integration/foundation.test.ts'],outfile:'scripts/dist/foundation-integration.test.js',bundle:true,platform:'node',format:'esm',packages:'external',alias,target:'node22'});
await build({entryPoints:['tests/integration/workspace.test.ts'],outfile:'scripts/dist/workspace-integration.test.js',bundle:true,platform:'node',format:'esm',packages:'external',alias,target:'node22'});
await build({entryPoints: ['apps/desktop/src/main/index.ts'], outfile: 'apps/desktop/dist/main.js', bundle: true, platform: 'node', format: 'esm', packages: 'external', alias, target: 'node22'});
await build({entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: 'apps/desktop/dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22'});
await viteBuild({root: 'apps/desktop/src/renderer', base: './', build: {outDir: '../../dist/renderer', emptyOutDir: true}});
await viteBuild({root:'apps/session-lab/viewer',base:'./',build:{outDir:'../dist/viewer',emptyOutDir:true}});
