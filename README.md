# 따바라 한모금 SIP

취향에 맞는 커스텀 음료를 추천하고, 사용자 조합을 공유하고, 참여자와 벌칙 음료를 추첨하는 TypeScript 원격 HTTP MCP 서버입니다. React UI는 없습니다.

## 설치 및 실행

Node.js **22 이상**이 필요합니다. 프로젝트 루트에서 실행합니다.

```sh
npm ci
npm run build
npm start
```

기본 MCP 엔드포인트: **`http://127.0.0.1:3000/mcp`**

개발 중에는 `npm run dev`를 사용할 수 있습니다. `better-sqlite3`의 사전 빌드 바이너리를 사용할 수 없는 OS/CPU에서는 네이티브 컴파일 도구가 필요할 수 있습니다.

다른 포트 또는 DB 파일을 사용하려면 다음과 같이 실행합니다.

```sh
PORT=4000 DATABASE_PATH=./data/custom.sqlite npm start
```

`.env`를 사용하려면 다음과 같이 명시적으로 로드합니다. `npm start`는 `.env`를 자동으로 읽지 않습니다.

```sh
cp .env.example .env
node --env-file=.env dist/index.js
```

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 1~65535 정수 |
| `HOST` | `127.0.0.1` | 바인딩 주소. 컨테이너에서는 필요에 따라 `0.0.0.0` |
| `DATABASE_PATH` | `./data/sip.sqlite` | 작업 디렉터리 기준 SQLite 파일 경로 |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | 허용할 Host 이름. 쉼표 구분, 포트·프로토콜·와일드카드 제외 |
| `ALLOWED_ORIGINS` | 빈 값 | 허용할 브라우저 Origin. 쉼표 구분, 예: `https://agent.example.com`. Origin 없는 서버 간 요청은 허용 |

DB와 상위 디렉터리는 자동 생성됩니다. 동일한 파일 경로를 사용하면 재시작 후에도 데이터가 유지됩니다. 배포 시 `data/`를 영속 볼륨에 두어야 합니다. SQLite WAL, 5초 busy timeout, 트랜잭션을 사용합니다. 서버는 SIGINT/SIGTERM 시 HTTP 요청을 정리하고 DB를 닫습니다.

## MCP 연결

- 전송 방식: **Streamable HTTP, stateless, JSON 응답**
- 경로: `/mcp`
- MCP 초기화 후 `tools/list`, `tools/call`을 사용할 수 있습니다.
- 요청마다 공식 SDK `Server`와 `StreamableHTTPServerTransport`를 새로 생성합니다. 공유 세션 ID나 전역 transport가 없어 동시 요청이 서로의 세션을 덮어쓰지 않습니다.
- `GET /mcp`, `DELETE /mcp`는 `405`입니다. 독립 SSE 스트림이나 서버 세션 종료는 제공하지 않습니다. 브라우저 주소창 GET으로 연결 여부를 판단하지 마세요.
- 요청은 `Content-Type: application/json`, `Accept: application/json, text/event-stream`을 사용합니다. 공식 SDK 클라이언트가 이를 처리합니다.

vooy에는 공개 HTTPS 주소 뒤에 `/mcp`를 붙여 **원격 MCP / Streamable HTTP** 서버로 등록합니다. 2026-10-25에 기존 vooy 연결의 도구 목록을 6개로 갱신하고 Recipe Studio에 전원 배정·결과 카드 지침을 반영했습니다. 실제 요기요 메뉴 조회 후 5명에게 일반 3·지옥맛 2 배정 결과를 확인했습니다.

실행 중인 로컬 또는 공개 엔드포인트를 SDK로 확인할 수 있습니다. 이 명령은 목록 조회, 추천, 빈 벌칙 후보의 오류 응답을 확인하며 데이터를 변경하지 않습니다.

```sh
npm run verify:mcp
npm run verify:mcp -- https://YOUR-TUNNEL.trycloudflare.com/mcp
```

## Tool 목록과 입력

| Tool | 필수 입력 | 선택 입력·기본값 |
| --- | --- | --- |
| `recommend_drinks` | `tasteKeyword` | `limit`: 3 |
| `create_recipe` | `name`, `baseDrink`, `modifiers`, `tasteKeywords` | `tags`: `[]`, `description`: `""`, `authorName`: `"익명"` |
| `list_recipes` | 없음 | `tasteKeyword`, `baseDrink`, `limit`: 20 |
| `draw_penalty` | `participants` | `candidates`, `tasteKeyword` (호환용) |
| `get_recipe` | `recipeId` | 없음 |
| `draw_drink_party` | `participants` | `hellCount`: 2, `normalCandidates`: [], `hellCandidates`: [] |

맛 키워드는 `달콤쌉싸름`, `시원상콤`, `고소담백`, `깔끔시원`입니다. 조회·추천에는 `랜덤`도 지원합니다. `랜덤`은 저장할 맛 속성이 아니므로 등록 시 사용할 수 없습니다. 추첨의 기존 `tasteKeyword` 입력은 허용하지만 후보 필터링에는 적용하지 않습니다.

조회 `limit`은 1~50 정수입니다. `list_recipes`의 맛과 베이스 필터는 AND 조건이며, 베이스는 정확히 일치해야 합니다. 결과는 `createdAt` 내림차순, 동일 시각이면 등록 순서의 역순입니다. `랜덤` 조회 필터는 맛 조건을 생략하지만 목록은 최신순을 유지합니다.

추천은 맛이 일치하는 **사용자 등록 레시피를 먼저** 가져오고, 모자란 개수만 같은 맛의 초기 예시로 보충합니다. 일반 추천은 좋아요·최신순이고 `랜덤` 추천은 각 그룹 안에서 무작위입니다. 데이터가 부족하면 실제 존재하는 결과만 반환합니다.

추첨은 서로 다른 이름을 가진 2~100명과 전달받은 `candidates`에서 `crypto.randomInt`로 각각 한 명과 한 조합을 선정합니다. **`menuVerified: true`, 추가 옵션 1개 이상, 모든 옵션 `verified: true`, `weirdnessScore: 5`인 후보만** 추첨합니다. 메뉴만 있거나 추가 옵션을 확인하지 못한 조합은 제외합니다. `candidates` 생략·빈 배열·필터링 후 0개이면 `NO_PENALTY_CANDIDATES`와 **"주문 가능한 벌칙 음료 후보 없음"**을 반환하며 DB 일반 음료로 대체하지 않습니다.

각 후보는 `storeName`, `menuName`, `basePrice`(원 단위 정수), `options: [{name, price, verified}]`, `menuVerified`, `weirdnessScore`(0~5 정수)를 포함합니다. 확인 플래그를 생략하면 false, 옵션을 생략하면 빈 배열로 처리해 추첨에서 제외합니다. 후보는 최대 50개, 후보당 옵션은 최대 20개입니다. 이름은 최대 100자, 각 가격은 0~1,000,000원이며 총액은 기본 가격과 선택 옵션 가격의 합입니다.

실제 메뉴·가격·옵션의 적용 가능 여부와 지옥맛 5점 판단은 **vooy Recipe에서 요기요 MCP 조회 결과를 근거로** 수행해야 합니다. 서버는 전달된 확인 선언과 점수만 검사하며 요기요에 직접 접속하거나 그 진위를 검증하지 않습니다. 단체방 여부도 vooy에서 확인합니다. 붙여 넣어 사용할 절차와 점수 기준은 [vooy 벌칙 Recipe 지침](docs/vooy-penalty-recipe.md)에 있습니다.

입력 예시 (`tools/call`의 `arguments`):

```json
{"tasteKeyword":"달콤쌉싸름","limit":3}
```

```json
{
  "name": "나의 초코 말차",
  "baseDrink": "말차라떼",
  "modifiers": [{"category":"시럽","name":"초코 시럽","quantity":1}],
  "tasteKeywords": ["달콤쌉싸름", "고소담백"],
  "tags": ["말차", "초코"],
  "description": "말차에 초코를 한 번 더",
  "authorName": "한모금"
}
```

```json
{"tasteKeyword":"고소담백","baseDrink":"말차라떼","limit":10}
```

```json
{"participants":["민지","철수","영희"],"candidates":[]}
```

```json
{"recipeId":"create_recipe가 반환한 UUID"}
```

모든 입력은 Zod로 검증합니다. 이름·베이스 최대 100자, 옵션 최대 20개, 옵션 종류 40자/이름 80자, 수량은 0 초과 100 이하의 숫자(0.5 가능), 태그 최대 10개/각 30자, 설명 최대 1000자, 작성자·참여자 이름 최대 50자입니다. 빈 이름, 제어 문자, 중복 참여자, 정의되지 않은 필드는 거부합니다. 추가 옵션이 없는 음료는 `modifiers: []`로 등록할 수 있습니다. 수량의 단위나 메뉴 옵션 대응은 주문하는 쪽에서 확인해야 합니다.

## 구조화된 결과와 오류

모든 Tool은 `structuredContent`에 JSON 객체를 반환하며, 호환성을 위해 `content[0].text`에도 같은 JSON 문자열을 제공합니다. Tool 목록에는 입력과 출력 JSON 스키마를 함께 제공합니다.

성공 결과 예시:

```json
{
  "ok": true,
  "data": {"recipeId":"서버가 생성한 UUID"}
}
```

Tool별 `data`:

- `recommend_drinks`: `{recipes, count, exampleCount}`
- `create_recipe`: `{recipeId}`
- `list_recipes`: `{recipes, count}`
- `draw_penalty`: `{winner, candidate, totalPrice, tags: ["지옥맛"]}`. `candidate`에는 매장·메뉴·기본 가격·추가 옵션과 가격·확인 플래그·독특함 점수가 포함됩니다.
- `draw_drink_party`: `{assignments, normalCount, hellCount, groupTotalPrice}`. 각 배정은 `{slot, participant, category, candidate, totalPrice}`이며 사람은 한 번씩, 음료는 중복될 수 있습니다.
- `get_recipe`: `{recipe, orderPayload: {baseDrink, modifiers}, orderAvailability: "not_verified"}`

레시피에는 `id`, `name`, `baseDrink`, `modifiers`, `tasteKeywords`, `tags`, `description`, `authorName`, `likesCount`, `createdAt`, `source`가 포함됩니다. 날짜는 UTC ISO 8601입니다. `source`는 `example` 또는 `user`입니다.

Tool 입력 오류는 MCP 결과에 `isError: true`와 다음 JSON을 반환합니다. Tool의 Zod 검증을 직접 수행하는 공식 SDK low-level handler를 사용하여 입력 오류도 구조화합니다.

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "입력값을 확인해 주세요.",
    "issues": [{"path":"participants","message":"벌칙 추첨에는 참여자가 최소 2명 필요합니다."}]
  }
}
```

오류 코드는 `VALIDATION_ERROR`, `RECIPE_NOT_FOUND`, `NO_PENALTY_CANDIDATES`, `NO_PARTY_CANDIDATES`, `CONFLICTING_CANDIDATES`, `UNKNOWN_TOOL`, `INTERNAL_ERROR`입니다. HTTP/JSON-RPC 형식 오류는 프로토콜 오류 응답으로 처리합니다. 내부 DB 오류의 상세 내용은 서버 로그에만 기록합니다.

`draw_penalty`에 전달한 후보가 모두 탈락하면 `NO_PENALTY_CANDIDATES`의 `error.issues`에 `candidates.0.menuVerified` 같은 탈락 필드 경로와 이유를 제공합니다. 후보 생략·빈 배열의 기존 오류 응답은 유지합니다. 확인 플래그 생략은 false로 처리하므로 실제 확인을 마쳤다면 메뉴와 각 옵션에 `true`를 명시해야 합니다. 정확한 JSON 예시와 vooy 호출 확인 절차는 [벌칙 Recipe 지침](docs/vooy-penalty-recipe.md)을 참고하세요.

## 단체 랜덤 음료 배정

`draw_drink_party`는 2~100명 전원에게 한 잔씩 배정합니다. 기본 지옥맛 인원은 2명이며 5명은 일반 3명·지옥맛 2명입니다. `hellCount`는 0부터 참여자 수까지 지정할 수 있습니다. Fisher–Yates와 `crypto.randomInt`로 지옥맛 대상자를 균등 선정하고 종류별 후보를 독립 추첨합니다. 같은 음료가 여러 사람에게 배정될 수 있습니다.

일반 후보의 구조는 벌칙 후보에서 `weirdnessScore`를 뺀 형태이며 옵션 없는 기본 메뉴도 허용합니다. 메뉴와 모든 추가 옵션의 확인 플래그는 true여야 합니다. 지옥맛 후보는 기존 5점 필터를 따릅니다. 필요한 종류의 후보가 없으면 전체 오류이며 부분 배정·DB 대체·데이터 저장은 하지 않습니다. 동일한 매장·메뉴·옵션 조합을 양쪽에 넣으면 `CONFLICTING_CANDIDATES`입니다. 실제 조회·별명과 결과 카드 표시 규칙은 [단체 배정 Recipe 지침](docs/vooy-party-recipe.md)을 참고하세요.

## 데이터와 공개 요청 제한

`Recipe` 테이블은 요청한 11개 필드와 예시 구분용 `source` 필드를 저장합니다. 배열은 JSON 문자열 컬럼에 저장하고 SQLite JSON 함수를 이용해 필터링합니다. SQL 값은 바인딩 매개변수를 사용합니다.

최초 실행 시 예시 12개를 생성합니다. 레몬에이드+샷, 말차라떼+초코 시럽, 홍차+바닐라 시럽, 아이스티+샷 등을 포함합니다. 고정 UUID와 트랜잭션으로 재시작 시 중복 생성하지 않습니다. 예시는 **실제 사용자 후기나 주문 가능한 메뉴 목록이 아닙니다**. 모든 레시피의 좋아요는 0에서 시작합니다.

- HTTP JSON 본문은 최대 32 KiB이며, 초과 시 `413`을 반환합니다.
- 잘못된 JSON은 `400`, 잘못된 Content-Type/압축 본문은 `415`입니다.
- Host 허용 목록과 Origin 허용 목록을 검사합니다. 기본 바인딩은 loopback입니다.
- HTTP 요청 수신 제한 시간은 30초, 헤더 수신 제한은 15초입니다.
- 로그인 없이 레시피를 공유하므로 공개 주소에 접근한 사용자는 조회·등록할 수 있습니다. 지속적인 공개 운영에서 필요한 트래픽 제한은 터널 또는 프록시에서 설정할 수 있습니다.

## 자동화 테스트

```sh
npm run typecheck
npm test
```

`npm test`는 빌드 후 별도의 임시 DB와 실제 HTTP 서버 프로세스를 생성합니다. 공식 MCP SDK `Client` + `StreamableHTTPClientTransport`로 테스트하고 종료 시 임시 데이터를 삭제합니다. 개발 DB는 변경하지 않습니다.

실제 검증 결과: **29개 통과, 0개 실패** (Node.js 24.11.1).

검증 범위는 서버 실행·초기화, 6개 Tool 목록/스키마, 초기 예시 12개와 좋아요 0, 5가지 추천 키워드, 사용자 등록·다른 클라이언트의 조회, 필터·최신순·예시 보충, 상세·주문 전달 구조, 각 Tool의 잘못된 입력·미등록 ID/Tool, 기본값, 요청 크기/JSON/메서드, Host/Origin, 8개 클라이언트 동시 요청, 실제 프로세스 종료·재시작 후 데이터 보존입니다. 후보 기반 추첨에서는 후보 생략/빈 배열의 DB 대체 금지, 5점만 선정, 메뉴·옵션 확인 조건과 일부 미확인 조합 제외, 가격 합산, 복수 후보 추첨, 입력 검증, 스키마 공개, 병렬 요청 격리, 전원 탈락의 필드별 진단, 일반 레시피·잘못 감싼 후보 구조의 입력 오류를 검증합니다. 테스트 후보는 합성 데이터이며 실제 요기요 주문 가능성은 검증하지 않습니다.

## cloudflared 연결 다음 단계

1. `cloudflared`를 설치하고 `npm start`로 서버를 실행합니다.
2. 별도 터미널에서 임시 터널을 엽니다.

   ```sh
   cloudflared tunnel --url http://127.0.0.1:3000
   ```

3. 출력된 `https://...trycloudflare.com`의 **호스트 이름만** `ALLOWED_HOSTS`에 추가하고 SIP 서버를 재시작합니다. 터널은 계속 실행해 둡니다.

   ```sh
   ALLOWED_HOSTS='localhost,127.0.0.1,[::1],YOUR-TUNNEL.trycloudflare.com' npm start
   ```

4. 공개 주소를 검증합니다.

   ```sh
   npm run verify:mcp -- https://YOUR-TUNNEL.trycloudflare.com/mcp
   ```

5. vooy에 위 HTTPS `/mcp` 주소를 Streamable HTTP로 등록하고 Tool 6개를 조회합니다. 단체방에서만 추첨할 수 있도록 vooy Recipe에 조건을 설정합니다. 브라우저가 Origin을 보내는 구성이라면 해당 Origin도 `ALLOWED_ORIGINS`에 명시합니다.

Cloudflare Quick Tunnel은 임시 테스트용이며 호스트가 재실행마다 변경됩니다. 또한 SSE를 지원하지 않으므로 이 서버는 Streamable HTTP의 JSON 응답 모드를 사용합니다. 상시 운영에는 고정 호스트를 가진 Cloudflare Tunnel을 구성합니다. 기존 터널을 유지하고 vooy 도구 설정을 갱신했습니다.

공식 참고: [MCP SDK 서버/Streamable HTTP](https://ts.sdk.modelcontextprotocol.io/server), [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## 파일 구조

```text
ttavara-sip/
├── src/
│   ├── index.ts          # 실행, 종료 처리
│   ├── config.ts         # 환경변수 검증
│   ├── http.ts           # /mcp, 본문 제한, Host/Origin
│   ├── database.ts       # SQLite 테이블, 저장·조회
│   ├── seeds.ts          # 예시 레시피 12개
│   ├── schemas.ts        # Zod 입력 및 레시피 스키마
│   └── tools.ts          # 공식 SDK 서버와 Tool 6개
├── test/mcp.test.ts      # 실제 프로세스 + SDK 통합 테스트
├── docs/vooy-penalty-recipe.md # 요기요 확인·지옥맛 후보 구성 지침
├── scripts/verify-mcp.ts # 공개/로컬 MCP 조회 검증
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.test.json
├── README.md
├── dist/                # 빌드 결과, Git 제외
└── data/sip.sqlite      # 실행 시 생성, Git 제외
```

런타임 패키지: `@modelcontextprotocol/sdk@1.32.2`, `better-sqlite3@13.0.3`, `express@5.3.0`, `zod@4.6.7`.

개발 패키지: `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/better-sqlite3`. 정확한 버전은 `package.json`과 잠금 파일에 고정했습니다.

## 구현하지 않은 범위

요기요 MCP 직접 호출·메뉴/주문 가능 여부 검증, React UI, 로그인, 결제, 좋아요 변경 기능, 서버의 실제 단체방 여부 검증은 구현하지 않았습니다. 기존 공개 터널과 vooy 연결의 도구 갱신 및 Studio 실시간 배정 테스트는 완료했습니다.
