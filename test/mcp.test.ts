import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { partyAssignmentSchema, penaltyCandidateSchema, recipeSchema, tasteKeywords } from '../src/schemas.js';

type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; issues?: { path: string; message: string }[] } };

function unpack(raw: CallToolResult): Envelope {
  assert.ok(raw.structuredContent, 'structuredContent is required');
  const text = raw.content.find((content) => content.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.deepEqual(JSON.parse(text.text), raw.structuredContent);
  return raw.structuredContent as Envelope;
}

async function unusedPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe('실제 HTTP MCP 서버 통합 테스트', { timeout: 60_000 }, () => {
  let directory: string;
  let port: number;
  let url: URL;
  let processHandle: ChildProcess | undefined;
  let client: Client;
  let recipeId: string;
  let initialExamples: unknown;
  const clients = new Set<Client>();
  const input = {
    name: '  테스트 말차 한모금  ', baseDrink: '말차라떼',
    modifiers: [{ category: '시럽', name: '초코 시럽', quantity: 0.5 }],
    tasteKeywords: ['달콤쌉싸름', '고소담백'],
    tags: ['공유', '테스트'], description: '실제 SDK 클라이언트로 등록한 테스트 조합', authorName: '테스터',
  };
  // Synthetic data: these flags test the contract, not real Yogiyo availability.
  const penaltyCandidate = {
    storeName: '합성 테스트 매장', menuName: '합성 테스트 토마토 음료', basePrice: 4000,
    menuVerified: true, weirdnessScore: 5,
    options: [
      { name: '합성 테스트 에스프레소 샷', price: 500, verified: true },
      { name: '합성 테스트 민트 시럽', price: 0, verified: true },
    ],
  };

  async function start() {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: resolve('.'),
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(directory, 'sip.sqlite'),
        ALLOWED_HOSTS: 'localhost,127.0.0.1,[::1],sip.example.test', ALLOWED_ORIGINS: 'https://agent.example.test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processHandle = child;
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`서버 시작 시간 초과: ${stderr}`)), 15_000);
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`서버 종료 ${code}: ${stderr}`)); });
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('"event":"listening"')) { clearTimeout(timer); resolve(); }
      });
    });
  }

  async function stop() {
    for (const connected of clients) await connected.close();
    clients.clear();
    const child = processHandle;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    processHandle = undefined;
    assert.equal(code, 0, `서버 종료 시그널: ${signal}`);
  }

  async function connect(name = 'sip-test') {
    const connected = new Client({ name, version: '1.0.0' });
    clients.add(connected);
    const transport = new StreamableHTTPClientTransport(url);
    await connected.connect(transport);
    assert.equal(transport.sessionId, undefined, 'stateless transport must not issue a session ID');
    return connected;
  }

  async function call(name: string, args: Record<string, unknown> = {}, connection = client) {
    const raw = await connection.callTool({ name, arguments: args }) as CallToolResult;
    const envelope = unpack(raw);
    assert.equal(raw.isError, undefined, JSON.stringify(envelope));
    assert.equal(envelope.ok, true);
    assert.ok(envelope.data);
    return envelope.data;
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ttavara-sip-'));
    port = await unusedPort();
    url = new URL(`http://127.0.0.1:${port}/mcp`);
    await start();
    client = await connect();
  });
  after(async () => {
    await stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('서버 실행 및 MCP 초기화 협상이 성공한다', () => {
    assert.equal(client.getServerVersion()?.name, 'ttavara-sip');
    assert.ok(client.getServerCapabilities()?.tools);
  });

  it('6개 Tool의 입력/출력 JSON 스키마를 조회한다', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['create_recipe', 'draw_drink_party', 'draw_penalty', 'get_recipe', 'list_recipes', 'recommend_drinks']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.outputSchema?.type, 'object');
    }
  });

  it('초기 예시가 12개이며 실제 후기와 구분되고 좋아요는 0이다', async () => {
    const response = await call('list_recipes', { limit: 50 });
    const recipes = z.array(recipeSchema).parse(response.recipes);
    assert.equal(recipes.length, 12);
    assert.ok(recipes.every((recipe) => recipe.source === 'example' && recipe.likesCount === 0));
    initialExamples = recipes;
  });

  it('4가지 맛 및 랜덤을 추천하고 기본 limit=3과 예시 보충을 적용한다', async () => {
    for (const keyword of [...tasteKeywords, '랜덤']) {
      const response = await call('recommend_drinks', { tasteKeyword: keyword });
      const recipes = z.array(recipeSchema).parse(response.recipes);
      assert.equal(response.count, 3);
      assert.equal(response.exampleCount, 3);
      assert.equal(new Set(recipes.map((recipe) => recipe.id)).size, 3);
      if (keyword !== '랜덤') assert.ok(recipes.every((r) => r.tasteKeywords.includes(keyword as typeof tasteKeywords[number])));
    }
    const response = await call('recommend_drinks', { tasteKeyword: '깔끔시원', limit: 50 });
    assert.ok(Number(response.count) < 50, '존재하지 않는 결과를 생성하지 않는다');
  });

  it('사용자 레시피를 SQLite에 등록하고 ID를 반환한다', async () => {
    const response = await call('create_recipe', input);
    recipeId = z.uuid().parse(response.recipeId);
  });

  it('다른 클라이언트가 새 레시피를 최신순으로 조회하고 필터를 적용한다', async () => {
    const other = await connect('another-user');
    const response = await call('list_recipes', { tasteKeyword: '고소담백', baseDrink: '말차라떼' }, other);
    const recipes = z.array(recipeSchema).parse(response.recipes);
    assert.equal(recipes[0]?.id, recipeId);
    assert.equal(recipes[0]?.source, 'user');
    assert.deepEqual(recipes[0]?.tags, input.tags);
    assert.equal(recipes[0]?.likesCount, 0);
    assert.ok(recipes.every((r) => r.baseDrink === '말차라떼' && r.tasteKeywords.includes('고소담백')));
    assert.equal((await call('list_recipes', { baseDrink: "' OR 1=1 --" })).count, 0);
    assert.equal((await call('list_recipes', { baseDrink: '말차라떼', tasteKeyword: '깔끔시원' })).count, 0);
  });

  it('사용자 조합을 우선 추천하고 모자란 수만 예시로 보충한다', async () => {
    const response = await call('recommend_drinks', { tasteKeyword: '달콤쌉싸름' });
    const recipes = z.array(recipeSchema).parse(response.recipes);
    assert.equal(recipes[0]?.id, recipeId);
    assert.equal(response.exampleCount, 2);
  });

  it('상세 조회는 구조화된 베이스와 옵션을 반환하고 주문 여부는 미검증으로 표시한다', async () => {
    const response = await call('get_recipe', { recipeId });
    const recipe = recipeSchema.parse(response.recipe);
    assert.equal(recipe.name, input.name.trim());
    assert.equal(recipe.description, input.description);
    assert.equal(recipe.authorName, input.authorName);
    assert.deepEqual(response.orderPayload, { baseDrink: input.baseDrink, modifiers: input.modifiers });
    assert.equal(response.orderAvailability, 'not_verified');
  });

  it('후보 생략·빈 배열이면 맛 입력과 관계없이 DB 대체 없이 후보 없음을 반환한다', async () => {
    const participants = ['민지', '철수', '영희'];
    assert.ok(Number((await call('list_recipes')).count) > 0, 'DB에 음료가 있어도 대체하지 않는다');
    for (const args of [{ participants }, { participants, candidates: [] }, { participants, tasteKeyword: '깔끔시원' }, { participants, candidates: [], tasteKeyword: '랜덤' }]) {
      const raw = await client.callTool({ name: 'draw_penalty', arguments: args }) as CallToolResult;
      assert.equal(raw.isError, true);
      assert.deepEqual(unpack(raw), {
        ok: false, error: { code: 'NO_PENALTY_CANDIDATES', message: '주문 가능한 벌칙 음료 후보 없음' },
      });
    }
  });

  it('전달된 확인 완료 5점 후보만 추첨하고 매장·메뉴·옵션 가격과 총액을 반환한다', async () => {
    const before = await call('list_recipes', { limit: 50 });
    const participants = ['민지', '철수', '영희'];
    for (const tasteKeyword of [undefined, '깔끔시원', '랜덤']) {
      const response = await call('draw_penalty', {
        participants, candidates: [penaltyCandidate], ...(tasteKeyword === undefined ? {} : { tasteKeyword }),
      });
      assert.ok(participants.includes(String(response.winner)));
      assert.deepEqual(penaltyCandidateSchema.parse(response.candidate), penaltyCandidate);
      assert.equal(response.totalPrice, 4500);
      assert.deepEqual(response.tags, ['지옥맛']);
      assert.equal(response.recipe, undefined);
    }
    assert.deepEqual(await call('list_recipes', { limit: 50 }), before, '후보는 DB 레시피를 변경하지 않는다');
  });

  it('독특함 0~4점은 제외하고 5점 후보만 추첨한다', async () => {
    const mild = Array.from({ length: 5 }, (_, weirdnessScore) => ({ ...penaltyCandidate, weirdnessScore }));
    const participants = ['민지', '철수'];
    const raw = await client.callTool({ name: 'draw_penalty', arguments: { participants, candidates: mild } }) as CallToolResult;
    assert.equal(raw.isError, true);
    assert.equal(unpack(raw).error?.code, 'NO_PENALTY_CANDIDATES');
    const response = await call('draw_penalty', { participants, candidates: [...mild, penaltyCandidate] });
    assert.deepEqual(response.candidate, penaltyCandidate);
  });

  it('후보 전원 탈락 시 누락된 확인 플래그·옵션·점수의 필드 경로를 반환한다', async () => {
    const { menuVerified: _menuVerified, ...withoutMenuFlag } = penaltyCandidate;
    const { verified: _verified, ...withoutOptionFlag } = penaltyCandidate.options[0]!;
    const { options: _options, ...withoutOptions } = penaltyCandidate;
    const raw = await client.callTool({ name: 'draw_penalty', arguments: {
      participants: ['민수', '지연', '철수'],
      candidates: [
        { ...withoutMenuFlag, options: [withoutOptionFlag, penaltyCandidate.options[1]!] },
        withoutOptions,
        { ...penaltyCandidate, weirdnessScore: 4 },
        { ...penaltyCandidate, menuVerified: false,
          options: [{ ...penaltyCandidate.options[0]!, verified: false }], weirdnessScore: 3 },
      ],
    } }) as CallToolResult;
    assert.equal(raw.isError, true);
    const envelope = unpack(raw);
    assert.equal(envelope.error?.code, 'NO_PENALTY_CANDIDATES');
    assert.equal(envelope.error?.message, '주문 가능한 벌칙 음료 후보 없음');
    assert.deepEqual(envelope.error?.issues?.map((issue) => issue.path), [
      'candidates.0.menuVerified', 'candidates.0.options.0.verified',
      'candidates.1.options', 'candidates.2.weirdnessScore',
      'candidates.3.menuVerified', 'candidates.3.options.0.verified', 'candidates.3.weirdnessScore',
    ]);
    assert.ok(envelope.error?.issues?.every((issue) => issue.message.length > 0));
  });

  it('잘못 감싼 candidates나 일반 레시피 구조는 후보 탈락과 구별되는 입력 오류다', async () => {
    for (const args of [
      { candidates: penaltyCandidate },
      { candidates: { recipes: [penaltyCandidate] } },
      { candidates: [{ baseDrink: '합성 음료', modifiers: [{ name: '합성 옵션', quantity: 1 }] }] },
      { candidates: [{ ...penaltyCandidate, options: ['합성 옵션'] }] },
      { candidates: [{ ...penaltyCandidate, verified: true }] },
    ]) {
      const raw = await client.callTool({ name: 'draw_penalty', arguments: {
        participants: ['민수', '지연', '철수'], ...args,
      } }) as CallToolResult;
      assert.equal(raw.isError, true);
      const envelope = unpack(raw);
      assert.equal(envelope.error?.code, 'VALIDATION_ERROR');
      assert.ok(envelope.error?.issues?.some((issue) => issue.path.startsWith('candidates')));
    }
  });

  it('메뉴만 존재하거나 옵션이 누락·미확인·일부 미확인인 후보 전체를 제외한다', async () => {
    const { menuVerified: _menuVerified, ...withoutMenuFlag } = penaltyCandidate;
    const { options: _options, ...withoutOptions } = penaltyCandidate;
    const { verified: _verified, ...withoutOptionFlag } = penaltyCandidate.options[0]!;
    const excluded = [
      { ...penaltyCandidate, menuVerified: false }, withoutMenuFlag,
      { ...penaltyCandidate, options: [] }, withoutOptions,
      { ...penaltyCandidate, options: [{ ...penaltyCandidate.options[0]!, verified: false }] },
      { ...penaltyCandidate, options: [withoutOptionFlag] },
      { ...penaltyCandidate, options: [penaltyCandidate.options[0]!, { ...penaltyCandidate.options[1]!, verified: false }] },
    ];
    const participants = ['민지', '철수'];
    for (const candidate of excluded) {
      const raw = await client.callTool({ name: 'draw_penalty', arguments: { participants, candidates: [candidate] } }) as CallToolResult;
      assert.equal(raw.isError, true);
      assert.equal(unpack(raw).error?.code, 'NO_PENALTY_CANDIDATES');
    }
    for (let draw = 0; draw < 10; draw++) {
      const response = await call('draw_penalty', { participants, candidates: [...excluded, penaltyCandidate] });
      assert.deepEqual(response.candidate, penaltyCandidate);
      assert.equal(response.totalPrice, 4500, '미확인 옵션을 제거한 변형 조합을 만들지 않는다');
    }
  });

  it('복수의 적격 후보에서만 무작위 선정하고 참여자 범위를 벗어나지 않는다', async () => {
    const participants = ['민지', '철수', '영희'];
    const candidates = [penaltyCandidate, { ...penaltyCandidate, storeName: '두 번째 합성 테스트 매장', basePrice: 5500 }];
    for (let draw = 0; draw < 20; draw++) {
      const response = await call('draw_penalty', { participants, candidates });
      const selected = penaltyCandidateSchema.parse(response.candidate);
      assert.ok(participants.includes(String(response.winner)));
      assert.deepEqual(selected, candidates.find((candidate) => candidate.storeName === selected.storeName));
      assert.equal(response.totalPrice, selected.basePrice + 500);
    }
  });

  it('후보 이름·가격·점수·확인 플래그·개수의 잘못된 입력을 검증한다', async () => {
    const invalid = [
      { ...penaltyCandidate, storeName: ' ' },
      { ...penaltyCandidate, menuName: '' },
      { ...penaltyCandidate, basePrice: -1 },
      { ...penaltyCandidate, basePrice: 100.5 },
      { ...penaltyCandidate, basePrice: '4000' },
      { ...penaltyCandidate, basePrice: 1_000_001 },
      { ...penaltyCandidate, weirdnessScore: 6 },
      { ...penaltyCandidate, weirdnessScore: 4.5 },
      { ...penaltyCandidate, weirdnessScore: -1 },
      { ...penaltyCandidate, weirdnessScore: undefined },
      { ...penaltyCandidate, menuVerified: 'true' },
      { ...penaltyCandidate, options: [{ name: '샷', price: -1, verified: true }] },
      { ...penaltyCandidate, options: [{ name: '샷', price: 500.5, verified: true }] },
      { ...penaltyCandidate, options: [{ name: '샷', verified: true }] },
      { ...penaltyCandidate, options: [{ name: '샷', price: 500, verified: 'true' }] },
      { ...penaltyCandidate, options: Array.from({ length: 21 }, () => penaltyCandidate.options[0]!) },
    ];
    const candidateLists = [...invalid.map((candidate) => [candidate]), Array.from({ length: 51 }, () => penaltyCandidate), null, 'invalid'];
    for (const candidates of candidateLists) {
      const raw = await client.callTool({ name: 'draw_penalty', arguments: { participants: ['민지', '철수'], candidates } }) as CallToolResult;
      assert.equal(raw.isError, true);
      const envelope = unpack(raw);
      assert.equal(envelope.error?.code, 'VALIDATION_ERROR');
      assert.ok(envelope.error.issues?.some((issue) => issue.path.startsWith('candidates')));
    }
  });

  it('후보 입력 스키마는 기존 필수 participants와 선택적 candidates를 공개한다', async () => {
    const { tools } = await client.listTools();
    const draw = tools.find((tool) => tool.name === 'draw_penalty')!;
    assert.deepEqual(draw.inputSchema.required, ['participants']);
    assert.ok(draw.inputSchema.properties?.candidates);
    const candidate = z.object({ items: z.object({
      required: z.array(z.string()), properties: z.record(z.string(), z.record(z.string(), z.unknown())),
    }) }).parse(draw.inputSchema.properties.candidates).items;
    assert.deepEqual(candidate.required, ['storeName', 'menuName', 'basePrice', 'weirdnessScore']);
    assert.equal(candidate.properties.menuVerified?.default, false);
    assert.equal(candidate.properties.weirdnessScore?.type, 'integer');
    const options = candidate.properties.options!;
    assert.equal(options.type, 'array');
    assert.deepEqual(options.default, []);
    const option = z.object({ required: z.array(z.string()), properties: z.object({
      verified: z.object({ type: z.literal('boolean'), default: z.literal(false) }),
    }) }).parse(options.items);
    assert.deepEqual(option.required, ['name', 'price']);
    assert.match(draw.description!, /요기요 MCP/u);
    assert.match(draw.description!, /weirdnessScore=5/u);
  });

  it('병렬 후보 추첨에서도 각 요청이 전달한 후보를 독립적으로 사용한다', async () => {
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const candidate = { ...penaltyCandidate, storeName: `병렬 테스트 매장-${index}` };
      const participants = [`참여자A-${index}`, `참여자B-${index}`];
      const response = await call('draw_penalty', { participants, candidates: [candidate] });
      assert.deepEqual(response.candidate, candidate);
      assert.ok(participants.includes(String(response.winner)));
    }));
  });

  it('단체 추첨은 5명 전원에게 한 잔씩 일반 3·지옥맛 2를 배정하고 DB를 보존한다', async () => {
    const before = await call('list_recipes', { limit: 50 });
    const participants = ['민수', '지연', '철수', '수진', '영희'];
    const normal = { storeName: '합성 일반 매장', menuName: '합성 아이스티', basePrice: 2500, menuVerified: true, options: [] };
    for (let draw = 0; draw < 20; draw++) {
      const response = await call('draw_drink_party', { participants, normalCandidates: [normal], hellCandidates: [penaltyCandidate] });
      const assignments = z.array(partyAssignmentSchema).parse(response.assignments);
      assert.equal(assignments.length, 5);
      assert.deepEqual(assignments.map((item) => item.participant), participants);
      assert.deepEqual(assignments.map((item) => item.slot), [1, 2, 3, 4, 5]);
      assert.equal(assignments.filter((item) => item.category === 'hell').length, 2);
      assert.equal(response.normalCount, 3);
      assert.equal(response.hellCount, 2);
      assert.equal(response.groupTotalPrice, 16500);
      for (const assignment of assignments) {
        assert.deepEqual(assignment.candidate, assignment.category === 'hell' ? penaltyCandidate : normal);
        assert.equal(assignment.totalPrice, assignment.category === 'hell' ? 4500 : 2500);
      }
    }
    assert.deepEqual(await call('list_recipes', { limit: 50 }), before);
  });

  it('단체 추첨은 인원 설정 0·1·전원과 일반 추가 옵션 가격을 지원한다', async () => {
    const normal = { storeName: '합성 일반 매장', menuName: '합성 라떼', basePrice: 3000, menuVerified: true,
      options: [{ name: '합성 바닐라', price: 500, verified: true }] };
    for (const hellCount of [0, 1, 3]) {
      const response = await call('draw_drink_party', { participants: ['가', '나', '다'], hellCount,
        normalCandidates: hellCount === 3 ? [] : [normal], hellCandidates: hellCount === 0 ? [] : [penaltyCandidate] });
      const assignments = z.array(partyAssignmentSchema).parse(response.assignments);
      assert.equal(assignments.filter((item) => item.category === 'hell').length, hellCount);
      assert.equal(response.groupTotalPrice, (3 - hellCount) * 3500 + hellCount * 4500);
    }
  });

  it('단체 추첨은 필요한 후보가 없으면 전체 실패하며 미확인 후보와 낮은 점수를 제외한다', async () => {
    const normal = { storeName: '합성 일반 매장', menuName: '합성 커피', basePrice: 2000, menuVerified: true, options: [] };
    const args = { participants: ['가', '나', '다', '라', '마'], normalCandidates: [normal], hellCandidates: [penaltyCandidate] };
    for (const changed of [
      { normalCandidates: [] }, { hellCandidates: [] },
      { normalCandidates: [{ ...normal, menuVerified: false }] },
      { normalCandidates: [{ ...normal, options: [{ name: '합성 옵션', price: 100 }] }] },
      { hellCandidates: [{ ...penaltyCandidate, weirdnessScore: 4 }] },
      { hellCandidates: [{ ...penaltyCandidate, options: [] }] },
      { hellCandidates: [{ ...penaltyCandidate, options: [{ name: '합성 옵션', price: 100 }] }] },
    ]) {
      const raw = await client.callTool({ name: 'draw_drink_party', arguments: { ...args, ...changed } }) as CallToolResult;
      assert.equal(raw.isError, true);
      assert.equal(unpack(raw).error?.code, 'NO_PARTY_CANDIDATES');
      assert.ok(unpack(raw).error?.issues?.length);
      assert.equal(unpack(raw).data, undefined);
    }
    const response = await call('draw_drink_party', { ...args,
      normalCandidates: [{ ...normal, menuVerified: false }, normal],
      hellCandidates: [{ ...penaltyCandidate, weirdnessScore: 4 }, penaltyCandidate] });
    assert.equal(response.groupTotalPrice, 15000);
  });

  it('단체 추첨은 양쪽에 겹친 조합과 잘못된 인원·후보 구조를 거부한다', async () => {
    const { weirdnessScore: _score, ...normal } = penaltyCandidate;
    const args = { participants: ['가', '나', '다'], normalCandidates: [normal], hellCandidates: [penaltyCandidate] };
    const conflict = unpack(await client.callTool({ name: 'draw_drink_party', arguments: args }) as CallToolResult);
    assert.equal(conflict.error?.code, 'CONFLICTING_CANDIDATES');
    for (const changed of [
      { hellCount: 4 }, { hellCount: -1 }, { hellCount: 1.5 }, { hellCount: '2' },
      { participants: ['가', ' 가 '] }, { participants: ['가'] },
      { normalCandidates: [penaltyCandidate] }, { normalCandidates: { recipes: [normal] } },
    ]) {
      const raw = await client.callTool({ name: 'draw_drink_party', arguments: { ...args, ...changed } }) as CallToolResult;
      assert.equal(raw.isError, true);
      assert.equal(unpack(raw).error?.code, 'VALIDATION_ERROR');
    }
    const { tools } = await client.listTools();
    const party = tools.find((tool) => tool.name === 'draw_drink_party')!;
    assert.deepEqual(party.inputSchema.required, ['participants']);
    assert.equal((party.inputSchema.properties?.hellCount as { default: number }).default, 2);
  });

  it('각 Tool의 잘못된 입력과 2명 미만/중복 참여자를 명확한 JSON 오류로 처리한다', async () => {
    const invalid: [string, Record<string, unknown>][] = [
      ['recommend_drinks', { tasteKeyword: '매운맛' }],
      ['recommend_drinks', { tasteKeyword: '랜덤', limit: 0 }],
      ['recommend_drinks', { tasteKeyword: '랜덤', limit: 51 }],
      ['recommend_drinks', { tasteKeyword: '랜덤', limit: 1.5 }],
      ['create_recipe', { ...input, name: '   ' }],
      ['create_recipe', { ...input, modifiers: [{ category: '샷', name: '샷', quantity: 0 }] }],
      ['create_recipe', { ...input, tasteKeywords: ['랜덤'] }],
      ['create_recipe', { ...input, likesCount: 999, source: 'example' }],
      ['list_recipes', { limit: '3' }],
      ['draw_penalty', { participants: ['민지'] }],
      ['draw_penalty', { participants: ['민지', ' 민지 '] }],
      ['draw_penalty', { participants: ['민지', ' '] }],
      ['get_recipe', { recipeId: 'invalid-id' }],
      ['get_recipe', {}],
    ];
    for (const [name, args] of invalid) {
      const raw = await client.callTool({ name, arguments: args }) as CallToolResult;
      const envelope = unpack(raw);
      assert.equal(raw.isError, true, name);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error?.code, 'VALIDATION_ERROR');
      assert.ok(envelope.error?.issues?.length);
    }
  });

  it('존재하지 않는 ID와 Tool은 명확한 오류를 반환한다', async () => {
    for (const [name, args, code] of [
      ['get_recipe', { recipeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'RECIPE_NOT_FOUND'],
      ['missing_tool', {}, 'UNKNOWN_TOOL'],
    ] as const) {
      const raw = await client.callTool({ name, arguments: args }) as CallToolResult;
      assert.equal(raw.isError, true);
      assert.equal(unpack(raw).error?.code, code);
    }
  });

  it('선택 필드의 기본값과 빈 추가 옵션을 지원한다', async () => {
    const { recipeId: id } = await call('create_recipe', {
      name: '기본값 테스트', baseDrink: '홍차', modifiers: [], tasteKeywords: ['깔끔시원'],
    });
    const recipe = recipeSchema.parse((await call('get_recipe', { recipeId: id })).recipe);
    assert.equal(recipe.authorName, '익명');
    assert.equal(recipe.description, '');
    assert.deepEqual(recipe.tags, []);
    assert.deepEqual(recipe.modifiers, []);
  });

  it('32 KiB 본문 제한, JSON 파싱, Content-Type 및 HTTP 메서드를 검증한다', async () => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ value: 'x'.repeat(33 * 1024) }) });
    assert.equal(response.status, 413);
    assert.match(JSON.stringify(await response.json()), /32 KiB/u);
    response = await fetch(url, { method: 'POST', headers, body: '{' });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: number } }).error.code, -32700);
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(response.status, 415);
    for (const method of ['GET', 'DELETE', 'PUT']) {
      response = await fetch(url, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
    }
  });

  it('허용되지 않은 Host와 Origin을 차단하고 허용된 터널 Host를 지원한다', async () => {
    // fetch may normalize Host; node:http sends the exact header being tested.
    const optionsRequest = (headers: Record<string, string>) => new Promise<{ status: number | undefined; origin: string | string[] | undefined }>((resolve, reject) => {
      const req = request(url, { method: 'OPTIONS', headers }, (res) => {
        res.resume();
        res.once('end', () => resolve({ status: res.statusCode, origin: res.headers['access-control-allow-origin'] }));
      });
      req.once('error', reject);
      req.end();
    });
    for (const headers of [{ Host: 'untrusted.example.test' }, { Origin: 'https://untrusted.example.test' }]) {
      const response = await optionsRequest(headers);
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
    const response = await optionsRequest({ Host: 'sip.example.test', Origin: 'https://agent.example.test' });
    assert.equal(response.status, 204);
    assert.equal(response.origin, 'https://agent.example.test');
  });

  it('8개 클라이언트의 동시 초기화/등록/조회와 동일 클라이언트의 병렬 요청이 충돌하지 않는다', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const parallel = await connect(`parallel-${index}`);
      const name = `동시등록-${index}`;
      const { recipeId: id } = await call('create_recipe', { ...input, name }, parallel);
      const response = await call('get_recipe', { recipeId: id }, parallel);
      assert.equal(recipeSchema.parse(response.recipe).name, name);
      return z.uuid().parse(id);
    }));
    assert.equal(new Set(ids).size, 8);
    await Promise.all(ids.map(async (id, index) => {
      const response = await call('get_recipe', { recipeId: id });
      assert.equal(recipeSchema.parse(response.recipe).name, `동시등록-${index}`);
    }));
  });

  it('서버 프로세스를 종료·재시작해도 사용자 데이터와 초기 예시가 중복 없이 유지된다', async () => {
    const beforeRestart = await call('list_recipes', { limit: 50 });
    await stop();
    await start();
    client = await connect('after-restart');
    const afterRestart = await call('list_recipes', { limit: 50 });
    assert.deepEqual(afterRestart, beforeRestart);
    const recipes = z.array(recipeSchema).parse(afterRestart.recipes);
    assert.deepEqual(recipes.filter((recipe) => recipe.source === 'example'), initialExamples);
    const recipe = recipeSchema.parse((await call('get_recipe', { recipeId })).recipe);
    assert.equal(recipe.name, input.name.trim());
    assert.deepEqual(recipe.modifiers, input.modifiers);
  });
});
