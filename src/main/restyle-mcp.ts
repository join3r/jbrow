import { randomBytes } from 'node:crypto'
import http from 'node:http'

/**
 * The smallest MCP server Claude Code will talk to: Streamable HTTP, JSON answers only (no
 * event streams), tools only. It listens on 127.0.0.1 on a port of its own and only answers
 * requests carrying its token, so other programs on this Mac can't drive the page through it.
 */

export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

export interface Tool {
  name: string
  description: string
  inputSchema: object
  call: (args: Record<string, unknown>) => Promise<ToolResult>
}

export interface McpServer {
  url: string
  /** Sent as `Authorization: Bearer <token>`. */
  token: string
  close: () => void
}

export function serveTools(tools: Tool[]): Promise<McpServer> {
  const token = randomBytes(24).toString('hex')
  const byName = new Map(tools.map((t) => [t.name, t]))

  const answer = async (msg: { id?: unknown; method?: string; params?: Record<string, unknown> }) => {
    const ok = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result })
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jbrow', version: '1' } })
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const tool = byName.get(String(msg.params?.name))
        if (!tool) return ok({ content: [{ type: 'text', text: `No tool named ${String(msg.params?.name)}.` }], isError: true })
        try {
          return ok(await tool.call((msg.params?.arguments as Record<string, unknown>) ?? {}))
        } catch (error) {
          return ok({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
        }
      }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } }
    }
  }

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end()
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    if (req.method !== 'POST') return void res.writeHead(405).end()
    let body = ''
    req.on('data', (d: Buffer) => (body += d.toString()))
    req.on('end', async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return void res.writeHead(400).end()
      }
      const batch = Array.isArray(parsed)
      // Notifications (no id) get no answer.
      const msgs = (batch ? parsed : [parsed]) as { id?: unknown }[]
      const answers = await Promise.all(msgs.filter((m) => m.id !== undefined).map(answer))
      if (!answers.length) return void res.writeHead(202).end()
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? answers : answers[0]))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${port}/`, token, close: () => server.close() })
    })
  })
}
