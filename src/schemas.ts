import { z } from 'zod';

export const tasteKeywords = ['달콤쌉싸름', '시원상콤', '고소담백', '깔끔시원'] as const;
export const tasteSchema = z.enum(tasteKeywords, {
  error: 'tasteKeyword는 달콤쌉싸름, 시원상콤, 고소담백, 깔끔시원 중 하나여야 합니다.',
});
export const queryTasteSchema = z.enum([...tasteKeywords, '랜덤'], {
  error: 'tasteKeyword는 달콤쌉싸름, 시원상콤, 고소담백, 깔끔시원, 랜덤 중 하나여야 합니다.',
});

export function textSchema(label: string, max: number) {
  return z.string({ error: `${label}: 문자열을 입력해 주세요.` }).trim()
    .min(1, `${label}: 공백이 아닌 값을 입력해 주세요.`)
    .max(max, `${label}: 최대 ${max}자까지 입력할 수 있습니다.`)
    .regex(/^[^\u0000-\u001f\u007f]*$/u, `${label}: 제어 문자는 사용할 수 없습니다.`);
}

export const modifierSchema = z.strictObject({
  category: textSchema('옵션 종류', 40),
  name: textSchema('옵션 이름', 80),
  quantity: z.number({ error: '옵션 수량은 숫자여야 합니다.' }).finite()
    .gt(0, '옵션 수량은 0보다 커야 합니다.').max(100, '옵션 수량은 최대 100입니다.'),
});
const limitSchema = z.number().int('limit은 정수여야 합니다.')
  .min(1, 'limit은 1 이상이어야 합니다.').max(50, 'limit은 최대 50입니다.');
const recipeIdSchema = z.uuid({ error: 'recipeId는 유효한 UUID여야 합니다.' });

export const createRecipeSchema = z.strictObject({
  name: textSchema('음료 이름', 100),
  baseDrink: textSchema('베이스 음료', 100),
  modifiers: z.array(modifierSchema).max(20, '추가 옵션은 최대 20개입니다.'),
  tasteKeywords: z.array(tasteSchema).min(1, '맛 키워드를 하나 이상 입력해 주세요.')
    .max(4).transform((values) => [...new Set(values)]),
  tags: z.array(textSchema('태그', 30)).max(10, '태그는 최대 10개입니다.')
    .default([]).transform((values) => [...new Set(values)]),
  description: z.string().trim().max(1000, '설명은 최대 1000자입니다.')
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), '설명에 허용되지 않는 제어 문자가 있습니다.')
    .default(''),
  authorName: textSchema('작성자', 50).default('익명'),
});
export const recommendSchema = z.strictObject({
  tasteKeyword: queryTasteSchema,
  limit: limitSchema.default(3),
});
export const listSchema = z.strictObject({
  tasteKeyword: queryTasteSchema.optional(),
  baseDrink: textSchema('베이스 음료', 100).optional(),
  limit: limitSchema.default(20),
});

const priceSchema = z.number({ error: '가격은 원 단위 숫자여야 합니다.' })
  .int('가격은 원 단위 정수여야 합니다.').min(0, '가격은 0원 이상이어야 합니다.')
  .max(1_000_000, '가격은 최대 1,000,000원입니다.');

export const penaltyOptionSchema = z.strictObject({
  name: textSchema('추가 옵션 이름', 100),
  price: priceSchema,
  verified: z.boolean().default(false)
    .describe('요기요 MCP에서 해당 메뉴에 적용 가능한 옵션과 가격을 실제 확인했으면 true를 명시. 생략 시 false로 처리해 후보 전체 제외'),
});

export const penaltyCandidateSchema = z.strictObject({
  storeName: textSchema('매장 이름', 100),
  menuName: textSchema('메뉴 이름', 100),
  basePrice: priceSchema,
  options: z.array(penaltyOptionSchema).max(20, '후보의 추가 옵션은 최대 20개입니다.').default([])
    .describe('해당 메뉴에 함께 적용 가능한 추가 옵션 객체 배열. 1개 이상 필요하며 각 항목에 name, price, verified: true 명시. 생략·빈 배열이면 후보 제외'),
  menuVerified: z.boolean().default(false)
    .describe('요기요 MCP에서 매장·메뉴·기본 가격을 실제 확인했으면 true를 명시. 생략 시 false로 처리해 후보 제외'),
  weirdnessScore: z.number().int('독특함 점수는 정수여야 합니다.').min(0).max(5)
    .describe('0~5점. 호불호가 강한 지옥맛 조합인 5점만 추첨하며 점수 판단은 vooy Recipe에서 수행'),
});

export const drawSchema = z.strictObject({
  participants: z.array(textSchema('참여자 이름', 50))
    .min(2, '벌칙 추첨에는 참여자가 최소 2명 필요합니다.')
    .max(100, '참여자는 최대 100명입니다.')
    .refine((values) => new Set(values).size === values.length, '참여자 이름은 중복될 수 없습니다. 구별되는 이름을 사용해 주세요.'),
  tasteKeyword: queryTasteSchema.optional(),
  candidates: z.array(penaltyCandidateSchema).max(50, '벌칙 음료 후보는 최대 50개입니다.').optional()
    .describe('요기요 MCP로 확인한 후보 객체 배열. 각 후보에 storeName, menuName, basePrice, menuVerified: true, weirdnessScore: 5, options: [{name, price, verified: true}] 전달. 생략·빈 배열이면 후보 없음. tasteKeyword는 적용하지 않음'),
});
export const getSchema = z.strictObject({ recipeId: recipeIdSchema });

// Ordinary drinks may have no extras; supplied extras still need verification.
export const normalCandidateSchema = penaltyCandidateSchema.omit({ weirdnessScore: true }).extend({
  options: z.array(penaltyOptionSchema).max(20).default([])
    .describe('일반 음료는 빈 배열 허용. 옵션이 있으면 해당 메뉴 동시 선택과 가격을 확인하고 각각 verified: true 명시'),
});
export const partySchema = z.strictObject({
  participants: drawSchema.shape.participants,
  hellCount: z.number().int().min(0).max(100).default(2)
    .describe('지옥맛 배정 인원. 기본 2명, 참여자 수 이하. 나머지는 일반 음료'),
  normalCandidates: z.array(normalCandidateSchema).max(50).default([])
    .describe('확인한 무난한 음료 후보. storeName, menuName, basePrice, menuVerified: true, options 배열. weirdnessScore는 넣지 않음'),
  hellCandidates: z.array(penaltyCandidateSchema).max(50).default([])
    .describe('확인한 지옥맛 후보. menuVerified: true, weirdnessScore: 5, options: [{name, price, verified: true}] 명시'),
}).refine((input) => input.hellCount <= input.participants.length, {
  path: ['hellCount'], message: '지옥맛 인원은 참여자 수 이하여야 합니다.',
});
export const partyAssignmentSchema = z.discriminatedUnion('category', [
  z.strictObject({ slot: z.number().int().positive(), participant: z.string(), category: z.literal('normal'),
    candidate: normalCandidateSchema, totalPrice: z.number().int().nonnegative() }),
  z.strictObject({ slot: z.number().int().positive(), participant: z.string(), category: z.literal('hell'),
    candidate: penaltyCandidateSchema, totalPrice: z.number().int().nonnegative() }),
]);

export const recipeSchema = z.strictObject({
  id: recipeIdSchema,
  name: z.string(),
  baseDrink: z.string(),
  modifiers: z.array(modifierSchema),
  tasteKeywords: z.array(tasteSchema),
  tags: z.array(z.string()),
  description: z.string(),
  authorName: z.string(),
  likesCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  source: z.enum(['example', 'user']).describe('example은 실제 사용자 후기가 아닌 초기 예시입니다.'),
});

export type Recipe = z.infer<typeof recipeSchema>;
export type CreateRecipeInput = z.infer<typeof createRecipeSchema>;
export type QueryTaste = z.infer<typeof queryTasteSchema>;
export type PenaltyCandidate = z.infer<typeof penaltyCandidateSchema>;
