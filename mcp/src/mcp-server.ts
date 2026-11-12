/**
 * stdio MCP server for portico.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout with the MCP
 * `initialize` / `tools/list` / `tools/call` methods and protocol version
 * `2024-11-05`. A tool failure is returned as MCP content with `isError: true`
 * so the transport keeps serving subsequent requests; only protocol-level
 * problems use a JSON-RPC error object.
 *
 * stdout carries protocol messages only. Diagnostics go to stderr.
 */

import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createToolsFromEnv, type ToolHost } from './tools.js';
import { isRecord, messageOf } from './guards.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'portico-x402';
export const MCP_SERVER_VERSION = '0.1.0';

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export interface ToolContent {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpServer {
  handle(request: unknown): Promise<JsonRpcResponse | null>;
}

function stringify(value: unknown): string {
  const text = JSON.stringify(
    value,
    (_key: string, item: unknown) => (typeof item === 'bigint' ? item.toString() : item),
    2
  );
  return text === undefined ? 'null' : text;
}

function toolContent(value: unknown, isError: boolean): ToolContent {
  const content: ToolContent = {
    content: [{ type: 'text', text: stringify(value) }],
  };
  if (isError) {
    content.isError = true;
  }
  return content;
}

function success(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id, error };
}

function readId(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return null;
}

/**
 * Build the request handler around a tool host.
 *
 * Notifications (requests without an `id`) are accepted and produce no
 * response, as the transport requires.
 */
export function createMcpServer(host: ToolHost): McpServer {
  const definitions = host.definitions;

  async function dispatch(
    id: string | number | null,
    method: string,
    params: unknown
  ): Promise<JsonRpcResponse> {
    switch (method) {
      case 'initialize':
        return success(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          instructions:
            'Quote and pay x402 v2 resources on NEAR. x402_pay signs one NEP-366 delegate ' +
            'through the portico facilitator; x402_verify_payment confirms the inner FT transfer.',
        });

      case 'ping':
        return success(id, {});

      case 'tools/list':
        return success(id, { tools: definitions });

      case 'tools/call': {
        if (!isRecord(params)) {
          return failure(id, -32602, 'Invalid params');
        }
        const name = params.name;
        if (typeof name !== 'string' || name.length === 0) {
          return failure(id, -32602, 'Invalid params: name must be a tool name');
        }
        const rawArguments = params.arguments;
        if (rawArguments !== undefined && !isRecord(rawArguments)) {
          return failure(id, -32602, 'Invalid params: arguments must be an object');
        }
        if (!definitions.some(definition => definition.name === name)) {
          return success(id, toolContent({ error: `Unknown tool: ${name}` }, true));
        }
        const args = rawArguments === undefined ? {} : rawArguments;
        try {
          return success(id, toolContent(await host.execute(name, args), false));
        } catch (error) {
          return success(id, toolContent({ tool: name, error: messageOf(error) }, true));
        }
      }

      default:
        return failure(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    async handle(request: unknown): Promise<JsonRpcResponse | null> {
      if (!isRecord(request)) {
        return failure(null, -32600, 'Invalid Request');
      }
      const rawId = request.id;
      const idAllowed =
        rawId === undefined ||
        rawId === null ||
        typeof rawId === 'string' ||
        typeof rawId === 'number';
      if (!idAllowed) {
        return failure(null, -32600, 'Invalid Request');
      }
      const method = request.method;
      if (request.jsonrpc !== '2.0' || typeof method !== 'string' || method.length === 0) {
        return failure(rawId === undefined ? null : readId(rawId), -32600, 'Invalid Request');
      }
      if (rawId === undefined) {
        return null;
      }
      try {
        return await dispatch(readId(rawId), method, request.params);
      } catch (error) {
        return failure(readId(rawId), -32603, 'Internal error', messageOf(error));
      }
    },
  };
}

/** Parse and answer one stdin line; returns the exact stdout line or `null`. */
export async function handleLine(server: McpServer, line: string): Promise<string | null> {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let request: unknown;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return JSON.stringify(failure(null, -32700, 'Parse error'));
  }
  const response = await server.handle(request);
  return response === null ? null : JSON.stringify(response);
}

/** Serve MCP over this process's stdin/stdout until the stream closes. */
export async function runStdioServer(host: ToolHost): Promise<void> {
  const server = createMcpServer(host);
  process.stderr.write(
    `portico MCP server ready: ${host.definitions.map(definition => definition.name).join(', ')}\n`
  );
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    const output = await handleLine(server, line);
    if (output !== null) {
      process.stdout.write(`${output}\n`);
    }
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    const host = createToolsFromEnv();
    await runStdioServer(host);
  } catch (error) {
    process.stderr.write(`portico MCP server failed: ${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}
