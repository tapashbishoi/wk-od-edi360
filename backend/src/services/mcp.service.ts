import { clip } from './chat/agent.js';
import { toJsonSchema } from '../utils/jsonSchema.js';
import { TOOLS, type Tool, type ToolCtx } from './chat/tools.js';

/**
 * EDI360's MCP (Model Context Protocol) server: the same read-only lookups the in-portal assistant uses,
 * offered to outside AI tools over JSON-RPC 2.0 (Streamable HTTP, stateless, plain JSON replies).
 *
 * Only reads. The propose_ tools exist for the portal chat's Confirm cards, which an outside client does not
 * have, so they are not offered. Every call is scoped to the tenant of the MCP key presented.
 */

export const SERVER_INFO = { name: 'edi360', title: 'EDI360', version: '1.0.0' };
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'EDI360 gives read-only access to one organisation\'s EDI documents: search documents and their status, check whether a 997 acknowledgment is pending, list trading partners, tickets and 997 reminder rules. ' +
  'Inbound means received from a partner; outbound means sent to a partner. Answer only from tool results. If a partner name is ambiguous, ask the user which one.';

export const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

export interface RpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: any }
export type RpcResponse = { jsonrpc: '2.0'; id: string | number | null; result: unknown } | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

export const mcpTools = (tools: Tool[] = TOOLS): Tool[] => tools.filter((t) => !t.decl.name.startsWith('propose_'));

export interface McpCtx extends Omit<ToolCtx, 'proposals'> {}

export interface CallLog { action: string; ok: boolean; ms: number; detail?: string }

const ok = (id: RpcResponse['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: RpcResponse['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** One JSON-RPC message in, one reply out (null for a notification, which gets none). */
export async function handleRpc(msg: RpcRequest, ctx: () => Promise<McpCtx>, log: (c: CallLog) => void, tools: Tool[] = mcpTools()): Promise<RpcResponse | null> {
  const t0 = Date.now();
  const isNotification = msg === null || typeof msg !== 'object' || !('id' in msg);
  const id = (!isNotification && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null) as RpcResponse['id'];

  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(id, ERR.invalidRequest, 'Not a valid JSON-RPC 2.0 request');
  const method = msg.method;

  if (isNotification) return null; // e.g. notifications/initialized

  switch (method) {
    case 'initialize': {
      const wanted = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      log({ action: 'initialize', ok: true, ms: Date.now() - t0 });
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      log({ action: 'tools/list', ok: true, ms: Date.now() - t0 });
      return ok(id, { tools: tools.map((t) => ({ name: t.decl.name, description: t.decl.description, inputSchema: toJsonSchema(t.decl.parameters) })) });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== 'string' || typeof args !== 'object' || Array.isArray(args)) return fail(id, ERR.invalidParams, 'tools/call needs a tool name and an arguments object');
      const tool = tools.find((t) => t.decl.name === name);
      if (!tool) {
        log({ action: 'unknown tool', ok: false, ms: Date.now() - t0, detail: `unknown tool ${String(name).slice(0, 40)}` });
        return fail(id, ERR.invalidParams, `Unknown tool: ${String(name).slice(0, 60)}`);
      }
      try {
        const c = await ctx();
        const result = clip(await tool.run({ ...c, proposals: [] }, args as Record<string, unknown>));
        const failed = !!(result && typeof result === 'object' && 'error' in (result as object));
        log({ action: name, ok: !failed, ms: Date.now() - t0, detail: failed ? String((result as any).error).slice(0, 200) : undefined });
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: failed });
      } catch (e: any) {
        log({ action: name, ok: false, ms: Date.now() - t0, detail: 'tool failed' });
        // A failed lookup is reported as a tool error so the client can tell the user, not as a protocol error
        return ok(id, { content: [{ type: 'text', text: 'That lookup failed. Try again.' }], isError: true });
      }
    }
    default:
      return fail(id, ERR.methodNotFound, `Method not found: ${method.slice(0, 60)}`);
  }
}

export { toJsonSchema };
