import express, { type ErrorRequestHandler, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { RecipeStore } from './database.js';
import { createMcpServer } from './tools.js';

function rpcError(res: Response, status: number, message: string, code = -32000) {
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
}

export function createApp(store: RecipeStore, config: Config) {
  const app = express();
  app.disable('x-powered-by');
  // Forwarded headers are deliberately not trusted; configure the real tunnel Host.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    let hostname: string;
    try {
      if (!req.headers.host) throw new Error('missing host');
      hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase();
    } catch {
      rpcError(res, 400, '유효한 Host 헤더가 필요합니다.');
      return;
    }
    if (!config.allowedHosts.includes(hostname)) {
      rpcError(res, 403, '허용되지 않은 Host입니다. ALLOWED_HOSTS 설정을 확인해 주세요.');
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      if (!config.allowedOrigins.includes(origin)) {
        rpcError(res, 403, '허용되지 않은 Origin입니다.');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, MCP-Session-Id');
    }
    next();
  });

  app.options('/mcp', (_req, res) => { res.sendStatus(204); });
  app.post('/mcp', (req, res, next) => {
    if (!req.is('application/json')) {
      rpcError(res, 415, 'Content-Type은 application/json이어야 합니다.');
      return;
    }
    next();
  }, express.json({ limit: '32kb', strict: true, inflate: false }), async (req, res) => {
    // Never share Server/Transport across HTTP requests, including initialization.
    const server = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({
      // Omitting sessionIdGenerator selects stateless mode in the SDK.
      enableJsonResponse: true,
    });
    res.once('close', () => {
      void server.close().catch((error: unknown) => console.error('MCP 정리 오류:', error));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP 요청 처리 오류:', error);
      if (!res.headersSent) rpcError(res, 500, '요청을 처리하지 못했습니다.', -32603);
      await server.close();
    }
  });
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST, OPTIONS');
    rpcError(res, 405, '이 서버는 stateless Streamable HTTP POST를 사용합니다.');
  });
  app.use((_req, res) => { rpcError(res, 404, '엔드포인트를 찾을 수 없습니다. /mcp를 사용해 주세요.'); });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') rpcError(res, 413, '요청 본문은 최대 32 KiB입니다.');
    else if (type === 'entity.parse.failed') rpcError(res, 400, '올바른 JSON 본문을 전송해 주세요.', -32700);
    else if (type === 'encoding.unsupported' || type === 'charset.unsupported') rpcError(res, 415, '압축되지 않은 UTF-8 JSON 본문을 사용해 주세요.');
    else {
      console.error('HTTP 처리 오류:', error);
      rpcError(res, 500, '서버 내부 오류가 발생했습니다.', -32603);
    }
  };
  app.use(errorHandler);
  return app;
}
