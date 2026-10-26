import type { CreateRecipeInput } from './schemas.js';

type Seed = Omit<CreateRecipeInput, 'authorName'>;
// These combinations are illustrative, not reviews, menu availability, or order guarantees.
export const exampleRecipes: readonly Seed[] = [
  {
    name: '레몬 샷 에이드', baseDrink: '레몬에이드',
    modifiers: [{ category: '샷', name: '에스프레소 샷', quantity: 1 }],
    tasteKeywords: ['달콤쌉싸름', '시원상콤'], tags: ['레몬', '커피', '예시'],
    description: '레몬의 산뜻함과 에스프레소의 쌉싸름함을 조합한 예시입니다.',
  },
  {
    name: '초코 말차라떼', baseDrink: '말차라떼',
    modifiers: [{ category: '시럽', name: '초코 시럽', quantity: 1 }],
    tasteKeywords: ['달콤쌉싸름', '고소담백'], tags: ['말차', '초코', '예시'],
    description: '말차라떼에 초코 시럽을 더한 예시 조합입니다.',
  },
  {
    name: '바닐라 홍차', baseDrink: '홍차',
    modifiers: [{ category: '시럽', name: '바닐라 시럽', quantity: 1 }],
    tasteKeywords: ['달콤쌉싸름'], tags: ['홍차', '바닐라', '예시'],
    description: '홍차의 쌉싸름한 향에 바닐라의 단맛을 더한 예시입니다.',
  },
  {
    name: '아샷추', baseDrink: '아이스티',
    modifiers: [{ category: '샷', name: '에스프레소 샷', quantity: 1 }],
    tasteKeywords: ['달콤쌉싸름'], tags: ['아이스티', '커피', '예시'],
    description: '달콤한 아이스티에 에스프레소 샷을 더한 예시입니다.',
  },
  {
    name: '유자 레몬에이드', baseDrink: '레몬에이드',
    modifiers: [{ category: '청', name: '유자청', quantity: 1 }],
    tasteKeywords: ['시원상콤'], tags: ['유자', '레몬', '예시'],
    description: '레몬에이드에 유자청을 더한 과일 음료 예시입니다.',
  },
  {
    name: '라임 자몽에이드', baseDrink: '자몽에이드',
    modifiers: [{ category: '과즙', name: '라임즙', quantity: 1 }],
    tasteKeywords: ['시원상콤', '깔끔시원'], tags: ['자몽', '라임', '예시'],
    description: '자몽에이드에 라임의 상큼함을 더한 예시입니다.',
  },
  {
    name: '오트 라떼', baseDrink: '카페라떼',
    modifiers: [{ category: '우유 변경', name: '오트 음료로 변경', quantity: 1 }],
    tasteKeywords: ['고소담백'], tags: ['오트', '라떼', '예시'],
    description: '카페라떼의 우유를 오트 음료로 바꾸는 예시입니다.',
  },
  {
    name: '흑임자 두유라떼', baseDrink: '두유라떼',
    modifiers: [{ category: '파우더', name: '흑임자 파우더', quantity: 1 }],
    tasteKeywords: ['고소담백'], tags: ['흑임자', '두유', '예시'],
    description: '두유라떼에 흑임자 파우더를 더한 고소한 예시입니다.',
  },
  {
    name: '시나몬 밀크티', baseDrink: '밀크티',
    modifiers: [{ category: '파우더', name: '시나몬 파우더', quantity: 0.5 }],
    tasteKeywords: ['고소담백'], tags: ['밀크티', '시나몬', '예시'],
    description: '밀크티에 시나몬을 소량 더한 예시입니다.',
  },
  {
    name: '레몬 아메리카노', baseDrink: '아이스 아메리카노',
    modifiers: [{ category: '과일', name: '레몬 슬라이스', quantity: 1 }],
    tasteKeywords: ['깔끔시원'], tags: ['커피', '레몬', '예시'],
    description: '아이스 아메리카노에 레몬 슬라이스를 더한 예시입니다.',
  },
  {
    name: '민트 탄산수', baseDrink: '탄산수',
    modifiers: [{ category: '허브', name: '민트', quantity: 1 }],
    tasteKeywords: ['깔끔시원'], tags: ['탄산', '민트', '예시'],
    description: '탄산수에 민트를 더한 깔끔한 음료 예시입니다.',
  },
  {
    name: '라임 콜드브루', baseDrink: '콜드브루',
    modifiers: [{ category: '과즙', name: '라임즙', quantity: 0.5 }],
    tasteKeywords: ['깔끔시원'], tags: ['콜드브루', '라임', '예시'],
    description: '콜드브루에 라임즙을 소량 더한 예시입니다.',
  },
];
