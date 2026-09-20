/** Optional newline-delimited JSON-RPC stdio adapter. Does not start when imported. */
import { createInterface } from 'node:readline';
import { Catalog } from '../catalog';
import { resolve } from 'node:path';
import { MemoryActor, MemoryEngine } from './index';
import { MEMORY_TOOLS, callMemoryTool } from './tools';

export function handleMemoryRpc(engine: MemoryEngine, actor: MemoryActor, request: Record<string, unknown>): unknown {
  if (request.id === undefined) return undefined;
  const result = (value: unknown) => ({ jsonrpc: '2.0', id: request.id, result: value });
  try {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case 'initialize': return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'co-memo', version: '0.1.0' } });
      case 'ping': return result({});
      case 'tools/list': return result({ tools: MEMORY_TOOLS });
      case 'tools/call': {
        try {
          const value = callMemoryTool(engine, actor, String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
          return result({ content: [{ type: 'text', text: JSON.stringify(value) }] });
        } catch (error) {
          return result({ isError: true, content: [{ type: 'text', text: (error as Error).message }] });
        }
      }
      default: return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
    }
  } catch { return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' } }; }
}

if (require.main === module) {
  const flags = process.argv.slice(2);
  const arg = (key: string) => { const index = flags.indexOf(key); return index >= 0 ? flags[index + 1] : undefined; };
  const filename = arg('--db'); const agentId = arg('--agent'); const project = arg('--project');
  if (!filename || !agentId) {
    process.stderr.write('Usage: node mcp.js --db <memory.sqlite> --agent <stable-agent-id> [--project <stable-project-id>]\n');
    process.exitCode = 1;
  } else {
    const engine = new MemoryEngine(resolve(filename));
    const actor = { agentId, projectId: project, stageId: arg('--stage'), purposeId: arg('--purpose') };
    const catalog = new Catalog(resolve(filename));
    catalog.validateActor(actor);
    const input = createInterface({ input: process.stdin });
    input.on('line', line => {
      let response: unknown;
      try {
        if (line.length > 65536) throw new Error('Message too large');
        const request: unknown = JSON.parse(line);
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid request');
        catalog.validateActor(actor);
        response = handleMemoryRpc(engine, actor, request as Record<string, unknown>);
      } catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message' } }; }
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    });
    input.on('close', () => { engine.close(); catalog.close(); });
  }
}
