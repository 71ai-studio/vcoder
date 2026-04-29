export * from "./client.js"
export * from "./server.js"

import { createVcoderClient } from "./client.js"
import { createVcoderServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createVcoder(options?: ServerOptions) {
  const server = await createVcoderServer({
    ...options,
  })

  const client = createVcoderClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
