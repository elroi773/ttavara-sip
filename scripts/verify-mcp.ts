import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';


// Read-only smoke check for local or cloudflared endpoints.
const endpoint = new URL(process.argv[2] ?? 'http://127.0.0.1:3000/mcp');
const client = new Client({ name: 'ttavara-sip-verifier', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  console.log(JSON.stringify({ endpoint: endpoint.href, server: client.getServerVersion(), tools: tools.map((t) => t.name) }, null, 2));
  const result = await client.callTool({ name: 'recommend_drinks', arguments: { tasteKeyword: '달콤쌉싸름' } }) as CallToolResult;
  console.log(JSON.stringify(result.structuredContent, null, 2));
  if (tools.length !== 6 || result.isError || result.structuredContent?.ok !== true) {
    throw new Error('Tool 목록 또는 음료 추천 검증에 실패했습니다.');
  }
  const draw = tools.find((tool) => tool.name === 'draw_penalty');
  if (!draw?.inputSchema.properties?.candidates) throw new Error('draw_penalty의 candidates 스키마가 없습니다.');
  const penalty = await client.callTool({
    name: 'draw_penalty', arguments: { participants: ['연결검증A', '연결검증B'], candidates: [] },
  }) as CallToolResult;
  const error = penalty.structuredContent?.error as { code?: string; message?: string } | undefined;
  if (!penalty.isError || penalty.structuredContent?.ok !== false || error?.code !== 'NO_PENALTY_CANDIDATES' || error.message !== '주문 가능한 벌칙 음료 후보 없음') {
    throw new Error('빈 후보의 DB 대체 금지 검증에 실패했습니다.');
  }
  console.log(JSON.stringify({ penaltyEmptyCandidates: penalty.structuredContent }, null, 2));
  const party = tools.find((tool) => tool.name === 'draw_drink_party');
  if (!party?.inputSchema.properties?.normalCandidates || !party.inputSchema.properties?.hellCandidates) {
    throw new Error('draw_drink_party의 일반/지옥맛 후보 스키마가 없습니다.');
  }
  const emptyParty = await client.callTool({
    name: 'draw_drink_party', arguments: { participants: ['연결검증A', '연결검증B', '연결검증C'] },
  }) as CallToolResult;
  if (!emptyParty.isError || (emptyParty.structuredContent?.error as { code?: string })?.code !== 'NO_PARTY_CANDIDATES') {
    throw new Error('단체 추첨의 빈 후보 오류 검증에 실패했습니다.');
  }
} finally {
  await client.close();
}
