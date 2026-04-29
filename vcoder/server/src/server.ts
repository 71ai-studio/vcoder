import http from "node:http"
import { AddressInfo } from "node:net"

export interface ServerOptions {
  port: number
  host?: string
}

export interface ServerHandle {
  url: string
  port: number
  close: () => Promise<void>
}

interface AppInfo {
  name: string
  version: string
  pid: number
  startedAt: string
}

const APP_INFO: AppInfo = {
  name: "vcoder",
  version: "0.1.0",
  pid: process.pid,
  startedAt: new Date().toISOString(),
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  })
  res.end(data)
}

export function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const host = opts.host ?? "127.0.0.1"

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`)

      if (req.method === "GET" && url.pathname === "/app") {
        return sendJson(res, 200, APP_INFO)
      }

      if (req.method === "POST" && url.pathname === "/tui/append-prompt") {
        const body = (await readJson(req)) as { text?: string }
        const text = typeof body?.text === "string" ? body.text : ""
        process.stdout.write(`\n[prompt] ${text}\n`)
        return sendJson(res, 200, { ok: true })
      }

      sendJson(res, 404, { error: "not_found", path: url.pathname })
    } catch (e) {
      sendJson(res, 500, { error: "internal", message: e instanceof Error ? e.message : String(e) })
    }
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, host, () => {
      const addr = server.address() as AddressInfo
      const port = addr.port
      const url = `http://${host}:${port}`
      resolve({
        url,
        port,
        close: () =>
          new Promise<void>((r, j) => {
            server.close((err) => (err ? j(err) : r()))
          }),
      })
    })
  })
}
