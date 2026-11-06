import {build} from 'esbuild';
import {readdir, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const kind = process.argv[2];
if (!['unit', 'integration'].includes(kind)) throw new Error('Unknown test suite');
const source = `tests/${kind}`;
const output = resolve(`node_modules/.cache/msm-tests/${kind}`);
await mkdir(output, {recursive:true});
const names = (await readdir(source)).filter(name => name.endsWith('.test.ts')).sort();
if (!names.length) throw new Error('No tests found');
await build({entryPoints:names.map(name => `${source}/${name}`), outdir:output, outExtension:{'.js':'.mjs'}, bundle:true, platform:'node', format:'esm', packages:'external', target:'node22', alias:Object.fromEntries(['contracts','crypto','database'].map(name => [`@msm/${name}`,resolve(`packages/${name}/src/index.ts`)]))});
// Each file registers node:test cases directly. Running the files separately also
// avoids inheriting a host application's test-worker IPC configuration.
for (const name of names) {
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [`${output}/${name.replace(/\.ts$/,'.mjs')}`], {stdio:'inherit'});
    child.once('error', reject);
    child.once('exit', value => done(value ?? 1));
  });
  if (code !== 0) {process.exitCode=1; break;}
}
