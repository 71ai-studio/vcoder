import { startServer } from "./server"

function parseArgs(argv: string[]): { port: number } {
  let port = 0
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--port" && argv[i + 1]) {
      port = parseInt(argv[++i], 10)
    } else if (a.startsWith("--port=")) {
      port = parseInt(a.slice("--port=".length), 10)
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: vcoder [--port <number>]")
      process.exit(0)
    }
  }

  if (!port || Number.isNaN(port)) {
    const env = process.env.VCODER_PORT
    port = env ? parseInt(env, 10) : 0
  }

  if (!port || Number.isNaN(port)) {
    port = 16384 + Math.floor(Math.random() * (65535 - 16384 + 1))
  }

  return { port }
}

async function main() {
  const { port } = parseArgs(process.argv.slice(2))
  const caller = process.env.VCODER_CALLER ?? "cli"

  const { url, close } = await startServer({ port })
  process.stdout.write(`vcoder listening on ${url} (caller=${caller})\n`)

  const shutdown = () => {
    close().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
