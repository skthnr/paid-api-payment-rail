import { describe, expect, it } from 'vitest';
import { createMcpServer, handleLine, type JsonRpcResponse } from '../src/mcp-server.js';
import type { ToolDefinition, ToolHost } from '../src/tools.js';

const definitions: readonly ToolDefinition[] = [
  {
    name: 'echo',
    description: 'Echo the supplied value',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'Value to echo' } },
      required: ['value'],
    },
  },
];

function host(execute: ToolHost['execute']): ToolHost {
  return { definitions, execute };
}

function responseOf(value: JsonRpcResponse | null): JsonRpcResponse {
  if (value === null) {
    throw new Error('expected a JSON-RPC response');
  }
  return value;
}

function resultRecord(response: JsonRpcResponse): Record<string, unknown> {
  if (typeof response.result !== 'object' || response.result === null) {
    throw new Error('expected an object result');
  }
  return response.result as Record<string, unknown>;
}

describe('MCP stdio shell', () => {
  it('initializes with the pinned protocol version and tool capability', async () => {
    const server = createMcpServer(host(async () => ({})));
    const response = responseOf(
      await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    );
    expect(response.id).toBe(1);
    expect(resultRecord(response)).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'portico-x402', version: '0.1.0' },
    });
  });

  it('lists the tool definitions', async () => {
    const server = createMcpServer(host(async () => ({})));
    const response = responseOf(
      await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    );
    expect(resultRecord(response)).toMatchObject({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    });
  });

  it('returns tool output as text content', async () => {
    const server = createMcpServer(host(async (_name, args) => ({ echoed: args.value })));
    const response = responseOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 'hello' } },
      })
    );
    expect(resultRecord(response)).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"echoed": "hello"') }],
    });
    expect(resultRecord(response).isError).toBeUndefined();
  });

  it('keeps the transport alive by returning tool failures as isError content', async () => {
    const server = createMcpServer(
      host(async () => {
        throw new Error('facilitator unavailable');
      })
    );
    const failed = responseOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 'x' } },
      })
    );
    expect(resultRecord(failed)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('facilitator unavailable') }],
    });

    const next = responseOf(await server.handle({ jsonrpc: '2.0', id: 5, method: 'ping' }));
    expect(resultRecord(next)).toEqual({});
  });

  it('marks unknown tools as tool errors, not protocol errors', async () => {
    const server = createMcpServer(host(async () => ({})));
    const response = responseOf(
      await server.handle({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'missing', arguments: {} },
      })
    );
    expect(response.error).toBeUndefined();
    expect(resultRecord(response)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Unknown tool: missing') }],
    });
  });

  it('answers protocol errors and ignores notifications', async () => {
    const server = createMcpServer(host(async () => ({})));
    const unknown = responseOf(
      await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' })
    );
    expect(unknown.error).toMatchObject({ code: -32601 });
    await expect(
      server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    ).resolves.toBeNull();
  });

  it('reports JSON parse failures without closing the stream', async () => {
    const server = createMcpServer(host(async () => ({})));
    const output = await handleLine(server, '{');
    expect(output).not.toBeNull();
    const parsed = JSON.parse(output ?? '{}') as JsonRpcResponse;
    expect(parsed.error).toMatchObject({ code: -32700 });
    const again = await handleLine(
      server,
      JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' })
    );
    expect(JSON.parse(again ?? '{}')).toMatchObject({ jsonrpc: '2.0', id: 8, result: {} });
  });
});
