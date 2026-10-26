# 단체 음료 복불복

5명이 요청하면 기본 일반 3명·지옥맛 2명, 전원 한 잔씩 배정한다. 지옥맛 대상자도 서버에서 균등 무작위 선정한다. 인원은 2~100명, hellCount는 0~참여자 수이며 기본 2다.

## 호출 계약

`draw_drink_party({participants, hellCount: 2, normalCandidates, hellCandidates})`

- 일반 후보: `{storeName, menuName, basePrice, menuVerified: true, options: []}`. 기본 메뉴는 옵션 없이 허용한다. 추가 옵션이 있으면 각각 `{name, price, verified: true}`. `weirdnessScore`는 넣지 않는다.
- 지옥맛 후보: 기존 draw_penalty 후보 구조와 동일하며 `weirdnessScore: 5`, 확인된 옵션 1개 이상 필요. Recipe에서는 시럽 2~3종 중심의 기본 지옥맛 기준을 적용한다.
- 모든 매장·메뉴·가격·옵션과 동시 선택 가능 여부는 Recipe가 실제 요기요 MCP에서 확인한다. 서버는 외부 검증이나 맛 평가를 하지 않는다.
- 각 후보 배열 최대 50개, 후보당 옵션 최대 20개, 본문 32 KiB 이내.
- 필요한 종류의 후보가 없으면 `NO_PARTY_CANDIDATES` 및 `error.issues`를 반환한다. 부분 배정이나 DB 대체 없음.
- 동일 매장·메뉴·옵션 조합이 양쪽 후보에 존재하면 `CONFLICTING_CANDIDATES`.
- 종류별 후보는 독립 추첨하므로 음료는 중복될 수 있다. 사람은 정확히 한 번씩만 배정된다.

## 결과 계약과 표시

`data.assignments`는 입력 순서대로 `{slot, participant, category: 'normal'|'hell', candidate, totalPrice}`다. `normalCount`, `hellCount`, `groupTotalPrice`도 반환한다. 총액은 각 기본 가격과 옵션의 합이며 배달비 제외다.

각 카드 맨 위에 AI가 만든 짧은 조합 별명을 제목으로 표시한다. 실제 판매 메뉴명과 구분하고 매장·지점·메뉴·옵션·가격은 그대로 유지한다. 단체 카드에는 slot도 표시한다.

```md
### 1번 😈 설탕폭탄 자몽에이드

1. **당첨자:** [도구의 participant] · 지옥맛 5/5
2. **메뉴:** [실제 카페·지점] — [실제 메뉴명]
3. **추가:** [옵션명과 추가 가격 / 없음 · 기본 메뉴]
4. **총액:** [도구의 totalPrice]원 · 배달비 제외
5. **확인:** [실제로 확인한 판매·동시 선택 조건]
```

지옥맛에는 구체적인 맛·향 부조화 이유 한 문장, 일반에는 🙂 무난 표시를 사용한다. 전원 카드 뒤에 음료 합계를 한 번 표시한다. 별명과 주관적 점수의 출처는 전체 결과에서 한 번 설명한다. 주문·결제·레시피 등록은 하지 않는다.

실제 적용 본문: `/Users/elroi/Documents/ChatGPT/vooy/vooy-instructions-party.md`. 로컬 문서는 Studio에 자동 반영되지 않는다. 서버 갱신 후 기존 MCP 설정을 저장해 6개 도구를 조회하고, Recipe의 서비스 연결에서도 새 도구를 선택한 뒤 지침을 반영한다.
