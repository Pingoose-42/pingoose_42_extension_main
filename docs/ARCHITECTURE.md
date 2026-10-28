# 아키텍처 설계와 리팩토링 철학

Pingoose는 GNOME Shell 데스크톱 확장과 별도의 WebKit 백그라운드 작업 프로세스로 실행됩니다. Shell 환경은 상태 표시와 UI 인터랙션을 담당하며, 백그라운드 프로세스는 Intra 인증 세션 유지와 주기적인 서버 폴링을 담당합니다.

---

## 1. 핵심 설계 및 리팩토링 철학

과거 Pingoose의 `extension.js`는 프로세스 I/O, IPC 메시지 라우팅, 전역 상태 저장소, UI 제어, 라이프사이클 관리를 한곳에서 도맡는 전형적인 **갓 객체(God Object)** 형태였습니다. 특히 하단에서 각 UI 컨트롤러의 프로토타입 메서드를 확장 클래스에 통째로 복사해 붙이는 믹스인(Mix-in) 구조로 인해, 독립되어야 할 도메인들이 `this._settings`, `this._indicator`, `this._slots` 등의 전역 상태를 무분별하게 공유하는 결합도(Coupling) 문제가 있었습니다.

이 복잡성을 해소하기 위해 Pingoose는 **"수평 레이어 분리"**와 **"수직 도메인 분리"** 두 가지 축으로 아키텍처를 재설계했습니다.

### ① 수평 레이어 분리: 통신 버스 격리 (`WorkerBridge`)
- **프로세스 및 I/O 캡슐화**: `Gio.Subprocess` 생성, 비동기 파이프 스트림(stdin/stdout) 처리, 버퍼링, JSON 직렬화/역직렬화는 오직 `WorkerBridge` 클래스가 전담합니다.
- **이벤트 기반 디스패칭**: 입출력 메시지를 거대한 `if/else`로 분기하지 않고, 이벤트 에미터(Event Emitter) 패턴을 통해 각 도메인 매니저가 필요한 메시지만 구독(`bridge.on('slots', ...)`, `bridge.on('evaluations', ...)`)합니다.
- **효과**: 상위 레이어는 프로세스 파이프나 버퍼 크기 같은 저수준 I/O 세부사항을 전혀 알 필요가 없습니다.

### ② 수직 도메인 분리: 상태와 UI를 묶은 독립 매니저 (Domain Managers)
기능별 도메인은 자체 상태, 비즈니스 규칙, UI 렌더링, 이벤트 구독을 스스로 책임지는 독립 서비스 클래스로 격리됩니다:
- **`SlotManager`**: 열린 평가 슬롯 목록, 슬롯 생성 드래프트 계산, 15분 단위 충돌 검사, 슬롯 자동 폴링, 로그아웃 세션 체크.
- **`EvaluationManager`**: 매칭된 평가 목록, 피드백 상태, 1초 카운트다운 타이머, 동료 프로필 및 좌석 연동.
- **`AgendaManager`**: 시험/이벤트 일정 카드, 구독 상태 전이, 숨김 카드(Dismissed ID) GSettings 동기화.
- **`NotificationManager`**: 알림 카드 목록, 디스크 영속화(`cardStore`), 시스템 알림 배너 및 화면 테두리 플래시.

### ③ 순수 컴포지션 루트 (Composition Root로서의 `extension.js`)
- `src/extension.js`는 두꺼운 비즈니스 로직이나 상태를 직접 소유하지 않습니다.
- 오직 컴포넌트들을 인스턴스화하고, 의존성(Indicator, WorkerBridge, Settings)을 주입(Dependency Injection)하며, 확장의 활성화(`enable()`)와 비활성화(`disable()`) 라이프사이클을 조율하는 역할만 수행합니다.

### ④ 명시적 수명 주기와 Clean State Rule
- GNOME Shell 확장은 비활성화 시 모든 액터, 타이머, 시그널 핸들러, 서브프로세스를 완전히 회수해야 메모리 누수와 쉘 충돌이 발생하지 않습니다.
- 모든 매니저는 `enable()`, `clear()`, `destroy()` 등 명시적인 라이프사이클 메서드를 제공하며, 부모가 파괴될 때 구독과 타이머를 깔끔하게 해제합니다.

---

## 2. 계층 구조 및 모듈 맵

```
src/
├── services/
│   ├── workerBridge.js       # [수평 I/O] Subprocess 수명주기, 비동기 파이프 스트림, 이벤트 에미터
│   ├── systemSessionHook.js  # [시스템 서비스] GNOME 로그아웃 시도 가로채기 및 슬롯 경고
│   ├── slotsService.js       # [슬롯 도메인 서비스] 42 Intra 슬롯 API 요청 페이로드/URL 처리
│   ├── chat.js               # [채팅 서비스] 피어간 TCP 소켓 연결 및 프로토콜
│   └── cardStore.js          # [영속화] 알림/테스트 카드 로컬 저장소
│
├── ui/
│   ├── slots.js              # [수직 도메인] SlotManager (슬롯 상태, 생성 UI, 렌더링)
│   ├── agenda.js             # [수직 도메인] AgendaManager (아젠다 상태, 구독 버튼, 렌더링)
│   ├── evaluations.js        # [수직 도메인] EvaluationManager (평가 매칭, 카운트다운, 피드백 UI)
│   ├── notifications.js      # [수직 도메인] NotificationManager (알림 카드, 배너, 플래시)
│   ├── chatPanel.js          # [사이드 패널] 클러스터 채팅 UI
│   ├── servicePanel.js       # [사이드 패널] 서비스 바로가기 패널
│   ├── projectPanel.js       # [사이드 패널] 프로젝트 메모/서브젝트 패널
│   └── indicator.js          # [탑바/메인 팝업] 기본 쉘 버튼 및 팝업 메뉴 컨테이너
│
├── models/                   # [순수 도메인 로직] 규칙, 시간 계산, 데이터 검증 (UI/I/O 무관, 상세: docs/MODEL_DESIGN_GUIDE.md)
│   ├── slotSchedule.js       # 슬롯 15분 단위 유효성 검사 및 페이로드 빌더
│   ├── agenda.js             # 아젠다 데이터 정규화 및 구독/마감 규칙
│   ├── evaluations.js        # 평가 상태 전이 및 알림 메시지 생성
│   └── chatPolicy.js         # 평가 15분 전 채팅 권한 계산
│
├── worker/                   # [백그라운드 프로세스] 독립 GJS/WebKit 프로세스 (Shell St/Main 참조 금지)
│   ├── webview.js            # Intra 웹뷰 및 헤드리스 세션 관리
│   └── agenda.js             # Intra 아젠다 HTTP 수집기
│
└── extension.js              # [컴포지션 루트] 순수 진입점 (컴포넌트 조립 및 활성화/종료)
```

---

## 3. 기능별 데이터와 이벤트 흐름

### (1) 백엔드 프로세스 통신 (IPC) 흐름
1. `WorkerBridge.start()`가 `/usr/bin/gjs src/worker/webview.js` 서브프로세스를 생성하고 파이프를 연결합니다.
2. 백그라운드 프로세스가 stdout으로 한 줄의 JSON 메시지를 출력합니다.
3. `WorkerBridge`가 비동기 스트림(`read_line_async`)으로 라인을 읽고 파싱하여 `emit(message.type, message)`를 발행합니다.
4. 각 도메인 매니저는 `bridge.on(type, handler)` 리스너를 통해 자신의 상태를 갱신하고 화면을 다시 그립니다.
5. 상위에서 하위로의 명령 전송은 `bridge.send(command)`를 통해 비동기 stdin 큐로 전달됩니다.

### (2) 슬롯(Slot) 흐름
1. `SlotManager`가 활성화되면 15분 주기로 `bridge.send('slots:list')`를 호출합니다.
2. `bridge.on('slots')` 이벤트가 도착하면 `SlotManager.onSlotsMessage()`가 상태를 갱신하고 `renderSlots()`를 호출합니다.
3. 사용자가 UI에서 슬롯 닫기 버튼을 누르면 `SlotManager`가 `bridge.send('slots:close:<id>')`를 발행합니다.
4. GNOME 세션 로그아웃 시 `SystemSessionHook`이 `SlotManager.sessionSlotRequest()`를 호출하여 열린 슬롯이 있는지 백엔드에 안전하게 질의합니다.

### (3) 평가(Evaluation) 및 피드백 흐름
1. 백엔드에서 `evaluations` 메시지가 오면 `EvaluationManager.onEvaluationsMessage()`가 수신합니다.
2. 1초 주기 타이머(`_evaluationClock`)가 `EvaluationManager.renderEvaluations()`를 호출하여 남은 시간을 실시간 갱신합니다.
3. 평가 시작 시각이 지나면 피드백 질문 카드("Have you submitted your evaluation feedback?")가 노출되고, 버튼 클릭 시 `bridge.send('feedback:<id>')`를 전송합니다.

---

## 4. 검증 및 테스트 가이드

프로젝트 루트에서 다음 명령으로 전체 검증을 수행합니다.

```sh
# 구문 검사, 모듈별 단위 테스트, 스키마 검증
bash src/scripts/test.sh

# 실제 로컬 TCP 소켓 핸드셰이크 및 채팅 프로토콜 검증 포함
bash src/scripts/test.sh --sockets
```

### Fragile Test 개선 원칙
과거 일부 테스트 코드는 `fs.readFileSync('src/extension.js')`로 소스 코드를 읽어 문자열 인덱스(`indexOf`)로 메서드를 잘라내어 Node VM에서 실행하는 취약한 방식을 취했습니다.

향후 테스트를 작성하거나 개선할 때는 다음 원칙을 준수합니다:
1. **모듈 직접 임포트**: `new SlotManager(...)`, `new WorkerBridge(...)`처럼 클래스 자체를 독립적으로 인스턴스화하여 테스트합니다.
2. **모의 객체 주입(Mocking / DI)**: 의존성(`bridge`, `indicator`, `settings`)은 최소한의 인터페이스를 가진 가상 객체로 주입합니다. 소스 코드의 특정 줄 번호나 공백에 의존하는 슬라이싱은 지양합니다.

---

루트 `install.sh`를 로컬 소스에서 실행하면 `src/scripts/install.sh`로 설치합니다. 스크립트만 내려받아 실행하면 `main`의 커밋 SHA를 확인하고, 해당 커밋의 `worker/updater.py`를 받아 `bootstrap` 명령으로 설치합니다. 최초 설치와 자동 업데이트는 `download_source()`와 `install_source()`를 함께 사용합니다.

내려받은 소스의 저장소·브랜치·커밋은 임시 소스 루트의 `.pingoose-source.json`에 기록합니다. 패키지를 만들 때 `source_receipt()`로 이 기록을 읽어 `config/installed.json`에 넣습니다. 로컬 소스에서는 Git 커밋을 읽습니다. 이 기록은 다음 업데이트에서 실제 설치 버전을 비교할 때 사용합니다.

## 변경 시 지킬 경계

- Shell 전용 `St`·`Main` 모듈을 독립 실행되는 `worker`에 가져오지 않습니다.
- 서버 파싱과 구독·시간 계산은 화면 렌더링에서 분리합니다.
- 비동기 요청은 계정 변경, 종료, 중복 요청과 늦은 응답을 고려합니다.
- 인증 헤더는 작업 프로세스 내부에서만 사용하고 메시지나 로그에 넣지 않습니다.
- GSettings 키와 저장 형식을 바꿀 때는 기존 사용자 데이터의 호환성을 확인합니다.
- GJS 42의 `imports` 방식에 맞춰 모듈을 작성합니다. Node 테스트용 `module.exports`는 GJS에서 실행되지 않도록 조건부로 둡니다.

## dev 리팩터링: 평가 상태와 조회 정책

`models/evaluationState.js`는 서버 스냅샷과 저장 상태를 합치는 `reconcile()`과
카드·알림 기준값을 함께 정리하는 `dismiss()`를 제공합니다. 입력 시각을 주입할 수
있으며 파일, WebKit, 타이머에 접근하지 않습니다. `worker/webview.js`는 조회·저장·메시지
전달을 담당합니다. `models/evaluationFeedback.js`의 `projectGroups()`는 같은 프로젝트의
카드를 묶고 테스트카드·조회 대상이 아닌 역할을 제외합니다.

추가 분리 후보는 `webview.js`의 상대 프로필 조회와 명령 라우팅,
`ui/projectPanel.js`의 입력 편집기, `ui/chatPanel.js`의 연결 입력 상태입니다.
이들은 비동기 취소·포커스·팝업 생명주기가 얽혀 있어 별도 동작 검증과 함께 분리해야 합니다.
이번 변경은 평가 규칙과 상태 정리의 경계를 분리하며 UI나 조회 주기를 변경하지 않습니다.
## 5. 새 기능 추가 시 지켜야 할 아키텍처 규칙

1. **`extension.js`를 무겁게 만들지 마십시오**:
   - 새 기능이나 패널이 추가될 경우 `extension.js` 안에 함수나 if문을 직접 구현하지 말고, `src/ui/` 또는 `src/services/`에 전담 매니저/서비스 클래스를 작성한 뒤 `extension.js`의 `enable()`에서 조립하십시오.
2. **IPC 메시지는 `WorkerBridge` 이벤트를 구독하십시오**:
   - 새 IPC 메시지 타입을 추가할 때는 `extension.js`의 분기문에 추가하지 말고, 해당 매니저 내부에서 `this._bridge.on('새메시지타입', data => ...)` 형태로 구독하십시오.
3. **계층 경계를 준수하십시오**:
   - `models/`: 순수 자바스크립트 로직만 포함 (UI 액터 생성 금지).
   - `worker/`: 백그라운드 전용 (Shell의 `St`, `Main`, `Clutter` import 엄격 금지).
   - `ui/`: 화면과 상태 관리 (장황한 비동기 소켓/파이프 I/O 로직 직접 구현 금지).
