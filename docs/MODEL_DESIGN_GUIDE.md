# 도메인 모델(Model) 설계 가이드 & 리팩토링 철학

> "모델(Model)이란 무엇이고, 어떻게 작성해야 읽기 쉽고 견고한 코드가 되는가?"
> 모델 계층을 처음 접하거나 설계하는 개발자를 위한 실전 가이드입니다.

---

## 1. 도메인 모델(Model)이란 무엇인가?

### 🍽️ 식당 비유로 쉽게 이해하기
소프트웨어 아키텍처를 식당에 비유하면 역할이 명확해집니다:
- **UI (View / Panel / Indicator)**: **홀 서빙 직원**
  - 손님(사용자)에게 메뉴판을 보여주고, 주문을 받고, 음식을 테이블에 예쁘게 세팅합니다.
- **Service / Worker / Bridge**: **장보기 및 주방 보조**
  - 바깥 시장(42 Intra 서버, 네트워크 소켓)에서 재료(데이터)를 사 오고 배달합니다.
- **Model (도메인 모델)**: **요리 레시피 & 영양 성분 계산기**
  - "이 재료가 상했는가?", "조리 시간이 얼마나 남았는가?", "이 주문이 유효한 규칙인가?"를 판단합니다.
  - **손님이 누구인지(UI), 재료를 어디서 사 왔는지(네트워크/파일 I/O)는 전혀 신경 쓰지 않고 오직 '순수한 규칙과 계산'에만 집중합니다.**

### 왜 모델을 UI나 통신 코드에서 따로 떼어내야 할까요?
1. **화면(UI)이 바뀌어도 규칙은 바뀌지 않습니다.**
   - 상단바 아이콘으로 표시하든, 팝업 카드로 표시하든, 시스템 배너로 띄우든 **"평가 15분 전부터 채팅이 가능하다"**는 규칙은 동일합니다. 규칙이 한곳(`models/chatPolicy.js`)에 모여 있어야 화면이 바뀔 때 규칙을 중복 작성하지 않아도 됩니다.
2. **테스트하기가 압도적으로 쉬워집니다.**
   - UI를 띄우거나 서버에 로그인하지 않아도, `grantsFrom(가짜_데이터)`를 넣고 기대한 결과가 나오는지 **0.01초 만에 검증**할 수 있습니다.

---

## 2. Pingoose 모델 계층의 5대 설계 원칙

### 원칙 1. 순수 함수(Pure Function)로 만들어라 (부수 효과 금지)
- **외부 상태를 바꾸지 않는다**: 전달받은 인자(`rows`, `data`)를 직접 수정(`data.pop()`, `row.checked = true`)하지 말고, 새로운 객체나 배열을 만들어 반환합니다.
- **화면(UI)이나 네트워크에 손대지 않는다**: `models/` 폴더 안에서는 `St`, `Clutter`, `Main`, `fetch`, `Gio.Subprocess` 등을 **절대 import하거나 사용하지 마십시오.**

### 원칙 2. 의도가 드러나는 이름을 써라 (No Code Golf)
- 코드를 한 줄로 짧게 줄이는 것(Code Golf)은 자랑이 아니라 **기술 부채**입니다.
- 복잡한 조건식은 **"의미를 설명하는 함수(Explanatory Function)"**나 **"설명 변수(Explanatory Variable)"**로 쪼개야 읽는 사람이 1초 만에 이해할 수 있습니다.

### 원칙 3. 경계값 검증(Validation)과 정규화(Normalization)를 철저히 하라
- 서버에서 온 JSON 데이터는 언제든 `null`, `undefined`, 깨진 문자열, 해킹 시도일 수 있습니다.
- 모델의 입구에서 즉시 검증(`parseRows`, `parseAgenda`)하여 정상 규격(정규화)으로 바꾸고, 규격에 안 맞으면 즉시 거절(Throw)합니다.
- 덕분에 모델을 거쳐 나온 데이터는 UI나 서비스 계층에서 안심하고 사용할 수 있습니다.

### 원칙 4. 결정론적(Deterministic)으로 동작하게 하라
- 현재 시각(`Date.now()`)에 의존하는 로직은 반드시 `now = Date.now()`처럼 **파라미터 기본값**으로 받으십시오.
- 그래야 테스트 코드에서 1년 전, 10분 뒤 같은 임의의 시각을 주입하여 완벽하게 테스트할 수 있습니다.

### 원칙 5. 환경 중립성 (Dual GJS & Node.js)
- Pingoose는 GNOME Shell 런타임(GJS)에서 구동되지만, 테스트는 초고속 Node.js에서 실행됩니다.
- 모델 파일 맨 밑에는 항상 다음 패턴을 유지합니다:
  ```javascript
  if (typeof module !== 'undefined') {
      module.exports = { parseAgenda, agendaAction, agendaSummary };
  }
  ```

---

## 3. 코드 냄새(Code Smells)와 안티패턴 체크리스트

모델 코드를 작성할 때 **절대 하지 말아야 할 4가지**:

❌ **1. 200자 넘는 한 줄 체이닝**
```javascript
// 나쁜 예: 읽는 사람이 숨이 턱 막힘
return rows.filter(r => !r.missing && (!r.devTest || (r.devSelf && selfLogin && r.users?.length===1 && r.users[0]===selfLogin)) && Date.parse(r.begin)>now && Date.parse(r.begin)-now<=WINDOW_MS)
```

❌ **2. 중첩 삼항 연산자 (? :)**
```javascript
// 나쁜 예: 무엇이 반환되는지 조건 추적이 불가능함
const state = now >= start ? (now < end ? 'In progress' : 'Ended') : diff > 60 ? 'Upcoming' : 'Starting';
```

❌ **3. 매직 넘버(Magic Number) 남발**
```javascript
// 나쁜 예: 899000이 대체 무슨 의미인지 모름
if (diff > 0 && diff <= 899000) { ... }

// 좋은 예: 상수로 명시
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000 - 1000; // 14분 59초
```

❌ **4. 모델 안에서 직접 파일/네트워크 I/O 수행**
- 모델은 계산만 해야 합니다. 파일 저장은 `services/`에서 담당해야 합니다.

---

## 4. 실전 예시로 배우는 모델 리팩토링 (Before & After)

### 사례: `src/models/chatPolicy.js`

#### 🔴 Before (지저분하고 난해한 코드)
```javascript
var WINDOW_MS = 899000;
function grantsFrom(rows, now = Date.now(), selfLogin = null) {
    return rows.filter(row => !row.missing && (!row.devTest || (row.devSelf && selfLogin && row.users?.length===1 && row.users[0]===selfLogin)) && Date.parse(row.begin)>now && Date.parse(row.begin)-now<=WINDOW_MS)
        .flatMap(row => (row.users || []).filter(login=>(row.devTest && row.devSelf && login===selfLogin) || (Number.isFinite(row.chatConfirmedAt?.[login]) && row.chatConfirmedAt[login]>=Date.parse(row.begin)-WINDOW_MS && row.chatConfirmedAt[login]<=now)).map(login => ({id:String(row.id),login,
            testSelf:!!row.devTest,seat:String(row.seats?.[login] || '').toLowerCase(),expires:Date.parse(row.begin)})))
        .filter(grant => /^[a-zA-Z0-9_-]{1,64}$/.test(grant.login) && /^c\d+r\d+s\d+$/.test(grant.seat));
}
```

#### 🟢 After (의도가 뚜렷하고 유지보수하기 쉬운 클린 코드)
```javascript
const FIFTEEN_MINUTES_MS = 899000; // 15분 직전 (899초)

// 1. 작은 의미 단위의 헬퍼 함수로 쪼갠다
function isUpcomingWithinFifteenMinutes(beginIsoString, now) {
    const timeUntilStart = Date.parse(beginIsoString) - now;
    return timeUntilStart > 0 && timeUntilStart <= FIFTEEN_MINUTES_MS;
}

function isTestSelfEvaluation(row, selfLogin) {
    return Boolean(row.devTest && row.devSelf && selfLogin &&
                   row.users?.length === 1 && row.users[0] === selfLogin);
}

function hasConfirmedSeatRecently(row, login, now) {
    const confirmedAt = row.chatConfirmedAt?.[login];
    const windowStart = Date.parse(row.begin) - FIFTEEN_MINUTES_MS;
    return Number.isFinite(confirmedAt) && confirmedAt >= windowStart && confirmedAt <= now;
}

function isValidGrant(grant) {
    const isValidLogin = /^[a-zA-Z0-9_-]{1,64}$/.test(grant.login);
    const isValidSeat = /^c\d+r\d+s\d+$/.test(grant.seat);
    return isValidLogin && isValidSeat;
}

// 2. 메인 함수는 흐름(파이프라인)이 한눈에 보이게 작성한다
function grantsFrom(rows, now = Date.now(), selfLogin = null) {
    // 1단계: 15분 이내의 유효한 평가 일정만 필터링
    const targetRows = rows.filter(row => {
        if (row.missing) return false;
        if (row.devTest && !isTestSelfEvaluation(row, selfLogin)) return false;
        return isUpcomingWithinFifteenMinutes(row.begin, now);
    });

    // 2단계: 각 평가의 참여자 중 채팅 자격이 있는 사람을 찾아 Grant 객체로 변환
    return targetRows.flatMap(row => {
        const users = row.users || [];
        return users
            .filter(login => isTestSelfEvaluation(row, selfLogin) || hasConfirmedSeatRecently(row, login, now))
            .map(login => ({
                id: String(row.id),
                login,
                testSelf: Boolean(row.devTest),
                seat: String(row.seats?.[login] || '').toLowerCase(),
                expires: Date.parse(row.begin)
            }));
    }).filter(isValidGrant);
}
```

---

## 5. 새 모델을 만들거나 리팩토링할 때의 체크리스트

코드를 작성한 후 다음 5가지 질문에 답해 보세요:

- [ ] **1. UI 요소가 전혀 없는가?** (`St`, `Clutter`, `Main` 등이 들어있지 않은가?)
- [ ] **2. 네트워크/디스크를 건드리지 않는가?** (`fetch`, `Soup`, `Subprocess`가 없는가?)
- [ ] **3. 한 줄에 조건식이 3개 이상 중첩되어 있지 않은가?** (그렇다면 함수로 분리했는가?)
- [ ] **4. 함수 이름만 보고도 무엇을 검증/계산하는지 바로 알 수 있는가?**
- [ ] **5. `Date.now()`를 파라미터 기본값(`now = Date.now()`)으로 받아 테스트 가능한가?**
- [ ] **6. 파일 하단에 `if (typeof module !== 'undefined') module.exports = ...`가 있는가?**

이 규칙을 지키면, **누가 읽어도 한눈에 이해되고 10년 뒤에도 버그 없이 동작하는 탄탄한 모델 코드**를 만들 수 있습니다.
