const esbuild = require("esbuild")

const watch = process.argv.includes("--watch")

const options = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  logLevel: "info",
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options)
    await ctx.watch()
  } else {
    await esbuild.build(options)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
