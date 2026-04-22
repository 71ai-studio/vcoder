const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info'
};

const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  { ...common, entryPoints: ['src/cli-review.ts'], outfile: 'dist/cli-review.js' },
  { ...common, entryPoints: ['src/cli-do.ts'], outfile: 'dist/cli-do.js' }
];

(async () => {
  if (watch) {
    const ctxs = await Promise.all(targets.map((t) => esbuild.context(t)));
    await Promise.all(ctxs.map((c) => c.watch()));
  } else {
    await Promise.all(targets.map((t) => esbuild.build(t)));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
