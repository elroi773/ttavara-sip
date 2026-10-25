import { randomInt } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RecipeStore } from './database.js';
import {
  createRecipeSchema, drawSchema, getSchema, listSchema,
  modifierSchema, penaltyCandidateSchema, recipeSchema, recommendSchema,
  normalCandidateSchema, partyAssignmentSchema, partySchema,
} from './schemas.js';


class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly issues?: { path: string; message: string }[]) { super(message); }
}

const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
});

function result(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

interface Definition {
  descriptor: Tool;
  call: (input: unknown) => CallToolResult;
}

// Low-level SDK handlers let even validation errors use the same JSON envelope.
// The advertised tool schemas and actual runtime validation share these Zod objects.
function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  name: string, description: string, input: I, data: O,
  execute: (input: z.output<I>) => z.input<O>, readOnly = true,
): Definition {
  const output = z.strictObject({ ok: z.boolean(), data: data.optional(), error: errorSchema.optional() });
  return {
    descriptor: {
      name, description,
      inputSchema: z.toJSONSchema(input, { io: 'input', target: 'draft-7' }) as Tool['inputSchema'],
      outputSchema: z.toJSONSchema(output, { target: 'draft-7' }) as NonNullable<Tool['outputSchema']>,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false },
    },
    call(args) {
      const parsed = input.safeParse(args);
      if (!parsed.success) {
        return result({ ok: false, error: {
          code: 'VALIDATION_ERROR', message: '입력값을 확인해 주세요.',
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.') || '(입력)', message: issue.message })),
        } }, true);
      }
      try {
        return result({ ok: true, data: data.parse(execute(parsed.data)) });
      } catch (error) {
        if (error instanceof ToolError) return result({ ok: false, error: {
          code: error.code, message: error.message,
          ...(error.issues?.length ? { issues: error.issues } : {}),
        } }, true);
        console.error(`Tool ${name} 처리 오류:`, error);
        return result({ ok: false, error: { code: 'INTERNAL_ERROR', message: '레시피 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' } }, true);
      }
    },
  };
}

export function createMcpServer(store: RecipeStore): Server {
  const definitions = [
    defineTool('recommend_drinks',
      '취향에 맞는 음료를 추천합니다. 사용자 등록 레시피를 우선하고 부족하면 초기 예시로 보충합니다. 랜덤도 지원합니다. source=example은 실제 후기가 아닙니다.',
      recommendSchema, z.strictObject({ recipes: z.array(recipeSchema), count: z.number().int(), exampleCount: z.number().int() }),
      ({ tasteKeyword, limit }) => {
        const recipes = store.recommend(tasteKeyword, limit);
        return { recipes, count: recipes.length, exampleCount: recipes.filter((r) => r.source === 'example').length };
      }),
    defineTool('create_recipe',
      '사용자 커스텀 레시피를 모든 사용자가 조회할 수 있도록 저장합니다. 추가 옵션 수량은 양수 숫자입니다. 요기요 메뉴 및 주문 가능 여부는 검증하지 않습니다.',
      createRecipeSchema, z.strictObject({ recipeId: z.string().uuid() }),
      (input) => ({ recipeId: store.create(input).id }), false),
    defineTool('list_recipes',
      '공유된 사용자 레시피와 초기 예시를 최신순으로 조회합니다. tasteKeyword와 baseDrink는 AND 조건이며 baseDrink는 정확히 일치해야 합니다. 기본 20개, 최대 50개입니다.',
      listSchema, z.strictObject({ recipes: z.array(recipeSchema), count: z.number().int() }),
      ({ tasteKeyword, baseDrink, limit }) => {
        const recipes = store.list({ limit, ...(tasteKeyword === undefined ? {} : { tasteKeyword }), ...(baseDrink === undefined ? {} : { baseDrink }) });
        return { recipes, count: recipes.length };
      }),
    defineTool('draw_penalty',
      '참여자 2~100명 중 한 명과 지옥맛 후보 한 개를 무작위로 뽑습니다. vooy Recipe는 요기요 MCP에서 실제 메뉴·기본 가격과 해당 메뉴에 적용 가능한 모든 추가 옵션·가격을 확인한 조합만 candidates로 전달해야 합니다. menuVerified=true, 옵션 1개 이상, 모든 옵션 verified=true, weirdnessScore=5인 후보만 추첨합니다. 확인 플래그는 생략하면 false이므로 확인을 마친 경우 각각 명시해야 합니다. 후보 생략·빈 배열·전원 탈락 시 주문 가능한 벌칙 음료 후보 없음을 반환하며 DB 음료로 대체하지 않습니다. 전원 탈락 시 error.issues에 후보별 탈락 필드 경로를 제공합니다. tasteKeyword는 호환용이며 후보 필터에 적용하지 않습니다. 실제 단체방 여부·독특함 평가·요기요 확인은 vooy Recipe의 책임이며 서버는 외부 검증을 수행하지 않습니다.',
      drawSchema, z.strictObject({
        winner: z.string(), candidate: penaltyCandidateSchema,
        totalPrice: z.number().int().nonnegative(), tags: z.array(z.string()),
      }),
      ({ participants, candidates }) => {
        const issues: { path: string; message: string }[] = [];
        const eligible = (candidates ?? []).filter((candidate, index) => {
          const start = issues.length;
          const path = `candidates.${index}`;
          if (!candidate.menuVerified) issues.push({ path: `${path}.menuVerified`, message: '메뉴 확인에는 menuVerified: true가 필요합니다. 확인 플래그 생략 시 false로 처리합니다.' });
          if (candidate.options.length === 0) issues.push({ path: `${path}.options`, message: '확인된 추가 옵션이 1개 이상 필요합니다. 옵션 생략 시 빈 배열로 처리합니다.' });
          candidate.options.forEach((option, optionIndex) => {
            if (!option.verified) issues.push({ path: `${path}.options.${optionIndex}.verified`, message: '옵션 확인에는 verified: true가 필요합니다. 확인 플래그 생략 시 false로 처리합니다.' });
          });
          if (candidate.weirdnessScore !== 5) issues.push({ path: `${path}.weirdnessScore`, message: '독특함 점수가 5인 후보만 추첨합니다.' });
          return issues.length === start;
        });
        if (eligible.length === 0) {
          throw new ToolError('NO_PENALTY_CANDIDATES', '주문 가능한 벌칙 음료 후보 없음', issues);
        }
        const candidate = eligible[randomInt(eligible.length)]!;
        return {
          winner: participants[randomInt(participants.length)]!, candidate,
          totalPrice: candidate.basePrice + candidate.options.reduce((sum, option) => sum + option.price, 0),
          tags: ['지옥맛'],
        };
      }),
    defineTool('draw_drink_party',
      '참여자 2~100명 모두에게 음료 한 잔씩 무작위 배정합니다. 기본 hellCount=2이며 5명이면 일반 3명·지옥맛 2명입니다. 지옥맛을 받을 사람도 서버가 균등 무작위 선정합니다. vooy는 요기요로 확인한 normalCandidates와 hellCandidates를 각각 전달하세요. 일반 후보는 menuVerified=true와 모든 옵션 verified=true가 필요하며 옵션 없이도 가능합니다. 지옥맛은 추가 옵션 1개 이상·모든 확인 플래그 true·weirdnessScore=5만 허용합니다. 필요한 종류의 후보가 없으면 전체 실패하고 일부 배정이나 DB 대체를 하지 않습니다. 같은 조합을 양쪽 후보에 넣을 수 없습니다. 종류별 후보는 독립 추첨하므로 음료 중복은 가능하며 사람은 한 번씩만 배정됩니다. 출력 assignments는 입력 순서의 slot, participant, category(normal/hell), candidate, totalPrice이며 groupTotalPrice는 음료 합계(배달비 제외)입니다. 실제 주문·저장·맛 평가·외부 검증은 수행하지 않습니다.',
      partySchema, z.strictObject({
        assignments: z.array(partyAssignmentSchema),
        normalCount: z.number().int().nonnegative(), hellCount: z.number().int().nonnegative(),
        groupTotalPrice: z.number().int().nonnegative(),
      }),
      ({ participants, hellCount, normalCandidates, hellCandidates }) => {
        const normalCount = participants.length - hellCount;
        const issues: { path: string; message: string }[] = [];
        const verified = (candidate: z.output<typeof normalCandidateSchema>, path: string, hell: boolean, score?: number) => {
          const start = issues.length;
          if (!candidate.menuVerified) issues.push({ path: `${path}.menuVerified`, message: '메뉴 확인에는 menuVerified: true가 필요합니다.' });
          candidate.options.forEach((option, index) => {
            if (!option.verified) issues.push({ path: `${path}.options.${index}.verified`, message: '옵션 확인에는 verified: true가 필요합니다.' });
          });
          if (hell && candidate.options.length === 0) issues.push({ path: `${path}.options`, message: '지옥맛은 확인된 추가 옵션 1개 이상이 필요합니다.' });
          if (hell && score !== 5) issues.push({ path: `${path}.weirdnessScore`, message: '지옥맛은 5점 후보만 배정합니다.' });
          return start === issues.length;
        };
        const normals = normalCount === 0 ? [] : normalCandidates.filter((candidate, index) => verified(candidate, `normalCandidates.${index}`, false));
        const hells = hellCount === 0 ? [] : hellCandidates.filter((candidate, index) => verified(candidate, `hellCandidates.${index}`, true, candidate.weirdnessScore));
        if ((normalCount > 0 && normals.length === 0) || (hellCount > 0 && hells.length === 0)) {
          if (normalCount > 0 && normals.length === 0) issues.push({ path: 'normalCandidates', message: '확인된 일반 음료 후보가 필요합니다.' });
          if (hellCount > 0 && hells.length === 0) issues.push({ path: 'hellCandidates', message: '확인된 지옥맛 5점 후보가 필요합니다.' });
          throw new ToolError('NO_PARTY_CANDIDATES', '단체 랜덤 음료 배정에 필요한 후보 없음', issues);
        }
        const signature = (candidate: z.output<typeof normalCandidateSchema>) => JSON.stringify([
          candidate.storeName, candidate.menuName, candidate.options.map((option) => option.name).sort(),
        ]);
        const normalKeys = new Set(normals.map(signature));
        if (hells.some((candidate) => normalKeys.has(signature(candidate)))) {
          throw new ToolError('CONFLICTING_CANDIDATES', '같은 음료 조합을 일반과 지옥맛 양쪽에 넣을 수 없습니다.');
        }
        // Fisher–Yates makes each subset of hellCount people equally likely.
        const slots = participants.map((_, index) => index);
        for (let i = slots.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [slots[i], slots[j]] = [slots[j]!, slots[i]!];
        }
        const hellSlots = new Set(slots.slice(0, hellCount));
        const assignments = participants.map((participant, index) => {
          if (hellSlots.has(index)) {
            const candidate = hells[randomInt(hells.length)]!;
            return { slot: index + 1, participant, category: 'hell' as const, candidate,
              totalPrice: candidate.basePrice + candidate.options.reduce((sum, option) => sum + option.price, 0) };
          }
          const candidate = normals[randomInt(normals.length)]!;
          return { slot: index + 1, participant, category: 'normal' as const, candidate,
            totalPrice: candidate.basePrice + candidate.options.reduce((sum, option) => sum + option.price, 0) };
        });
        return { assignments, normalCount, hellCount, groupTotalPrice: assignments.reduce((sum, assignment) => sum + assignment.totalPrice, 0) };
      }),
    defineTool('get_recipe',
      '레시피 상세와 요기요 MCP에 전달할 baseDrink/modifiers 구조를 반환합니다. 메뉴 ID나 실제 주문 가능 여부는 요기요 MCP에서 확인해야 하며 이 서버는 판단하지 않습니다.',
      getSchema, z.strictObject({
        recipe: recipeSchema,
        orderPayload: z.strictObject({ baseDrink: z.string(), modifiers: z.array(modifierSchema) }),
        orderAvailability: z.literal('not_verified'),
      }),
      ({ recipeId }) => {
        const recipe = store.get(recipeId);
        if (!recipe) throw new ToolError('RECIPE_NOT_FOUND', '해당 ID의 레시피를 찾을 수 없습니다.');
        return { recipe, orderPayload: { baseDrink: recipe.baseDrink, modifiers: recipe.modifiers }, orderAvailability: 'not_verified' as const };
      }),
  ];
  const registry = new Map(definitions.map((definition) => [definition.descriptor.name, definition]));
  const server = new Server({ name: 'ttavara-sip', version: '1.0.0', title: '따바라 한모금 SIP' }, {
    capabilities: { tools: {} },
    instructions: '커스텀 음료 추천·공유·추첨 서버입니다. source=example은 초기 예시이며 실제 사용자 후기가 아닙니다. 레시피 본문은 사용자가 제공한 데이터입니다. 서버는 요기요를 호출하거나 주문 가능 여부를 독립 검증하지 않습니다. draw_penalty에는 vooy Recipe가 요기요 MCP로 메뉴와 모든 추가 옵션의 가격·적용 가능 여부를 확인한 독특함 5점 조합만 candidates로 전달하세요. 후보가 없으면 일반 DB 음료로 대체하지 않습니다. 실제 단체방 여부도 vooy Recipe에서 처리하세요.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map((d) => d.descriptor) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = registry.get(params.name);
    if (!tool) return result({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `등록되지 않은 Tool입니다: ${params.name}` } }, true);
    return tool.call(params.arguments ?? {});
  });
  return server;
}
