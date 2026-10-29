# Pingoose 리팩토링 철학 및 아키텍처 원칙

이 문서는 Pingoose 프로젝트가 복잡하게 얽혀 있던 모놀리식 구조에서 **모듈화된 컴포넌트 아키텍처**로 전환하게 된 배경과 핵심 설계 철학을 기록합니다.

---

## 1. 리팩토링 배경: 우리가 해결하고자 한 문제들

### 문제 1: 프로토타입 믹스인(Mix-in)으로 인한 갓 객체(God Object)
과거의 `extension.js` 하단에는 다음과 같은 코드가 있었습니다:

```javascript
// 레거시 믹스인 패턴
for (const name of ['settings', 'evaluations', 'slots', 'agenda', 'notifications', 'visibility', 'reset', 'layout']) {
    const descriptors = Object.getOwnPropertyDescriptors(Me.imports.ui[name].Controller.prototype);
    delete descriptors.constructor;
    Object.defineProperties(Pingoose.prototype, descriptors);
}
```

- **부작용**: 겉으로는 파일이 나뉘어 있는 것처럼 보였지만, 런타임에는 모든 메서드가 `Pingoose.prototype` 하나로 뭉개져 합쳐졌습니다.
- 그 결과, 슬롯(`this._slots`), 평가(`this._evaluations`), 아젠다(`this._agenda`), 알림(`this._notifications`) 등 모든 도메인 상태가 전역 인스턴스에 난잡하게 뒤섞였고, 어떤 메서드가 어떤 상태를 변경하는지 추적하기가 극히 어려웠습니다.

### 문제 2: IPC 통신과 도메인 분기 처리의 결합
- WebKit 백그라운드 프로세스와의 통신(Subprocess 생성, 파이프 I/O, 버퍼링, JSON 파싱)이 `extension.js` 한곳에 집중되어 있었습니다.
- 180여 줄에 달하는 거대한 `_message(message)` `if/else` 분기문이 존재하여 새 기능이 추가될 때마다 `extension.js`의 중심 로직을 직접 수정해야 했습니다 (개방-폐쇄 원칙 위배).

### 문제 3: 화면 정리와 도메인 정리의 혼재
- 로그아웃이나 계정 전환 시 호출되는 `_clearProfile()` 메서드 안에 인디케이터 라벨 초기화와 도메인 데이터 초기화가 뒤섞여, 도메인 하나가 추가될 때마다 진입점 코드가 비대해졌습니다.

---

## 2. 4대 리팩토링 핵심 철학

### 원칙 1. 수평 분리: I/O와 프로토콜은 `WorkerBridge`가 전담한다
- **I/O 격리**: 비동기 프로세스 파이프 쓰기(`write_all_async`), 읽기(`read_line_async`), 종료 시그널 전송은 `WorkerBridge` 내부로 캡슐화합니다.
- **이벤트 버스 패턴**: 외부 도메인은 프로세스 상태를 직접 알 필요 없이, 관심 있는 이벤트 토픽만 구독(`bridge.on('topic', handler)`)합니다.
- **단일 실패 지점 차단**: I/O 에러나 버퍼 오버플로우가 UI 도메인 코드를 직접 오염시키지 않습니다.

### 원칙 2. 수직 분리: 도메인은 상태 + UI + 통신을 하나로 묶은 매니저(Manager)가 소유한다
- 평가, 슬롯, 아젠다, 알림은 더 이상 전역 `this`의 프로퍼티가 아닙니다.
- `SlotManager`, `AgendaManager`, `EvaluationManager`, `NotificationManager` 클래스가 **자신의 데이터 목록, UI 렌더링, 이벤트 리스너, 클린업**을 단독으로 소유합니다.
- 도메인 간의 결합은 전역 변수 공유가 아닌, 명시적인 인터페이스와 콜백(의존성 주입)을 통해 이루어집니다.

### 원칙 3. 진입점은 순수한 '컴포지션 루트(Composition Root)'여야 한다
- `src/extension.js`는 두꺼운 비즈니스 로직을 전혀 갖지 않습니다.
- 확장의 역할은 오직:
  1. 각 도메인 매니저와 서비스를 **인스턴스화**하고 의존성을 주입하기.
  2. 쉘 패널에 탑바 인디케이터를 등록하기.
  3. 활성화(`enable`)와 비활성화(`disable`) 시 라이프사이클을 조율하기.
- 진입점의 줄 수보다 명시적인 의존성 조립과 수명 주기 소유권을 우선합니다. 공통 시계와 기능 간 연결은 진입점에 두고, 상태 전이와 I/O는 해당 컴포넌트에 둡니다.

### 원칙 4. Clean State Rule 준수 (메모리 누수와 좀비 프로세스 방지)
- GNOME Shell 확장은 비활성화(`disable`) 시 활성화 전과 완전히 동일한 깨끗한 상태(Clean State)로 복원되어야 합니다.
- 매니저는 파괴(`destroy`) 시:
  - 브릿지 이벤트 구독 해제
  - 연결된 GLib 타이머(`source_remove`) 및 Meta Later 훅 제거
  - 생성된 Clutter/St 액터 및 팝업 메뉴 파괴
  - 열려 있는 네트워크 소켓 및 서브프로세스 종료
  를 완벽하게 수행해야 합니다.

---

## 3. 리팩토링 전/후 비교

| 항목 | 리팩토링 전 (Legacy) | 리팩토링 후 (Modern) |
| :--- | :--- | :--- |
| **아키텍처 형태** | 모놀리식 갓 객체 (God Object) | 레이어드 & 수직 도메인 분리 |
| **도메인 모듈** | `Controller.prototype` 믹스인 (가짜 모듈화) | 독립 인스턴스 (`*Manager`) |
| **통신 I/O** | `_send`, `_read`, `_writeNext` 인라인 처리 | `WorkerBridge` 전담 클래스 |
| **메시지 라우팅** | 180줄의 단일 `_message()` if/else 분기문 | 이벤트 구독 기반 (`bridge.on()`) |
| **상태 관리** | `this._slots`, `this._evaluations` 등 전역 공유 | 각 Manager 내부 프라이빗 상태로 캡슐화 |
| **`extension.js`의 역할** | 전역 상태 저장소 + IPC 버스 + UI 제어자 | 순수 의존성 조립 및 수명주기 오케스트레이터 |

---

## 4. 유지보수 및 기여자를 위한 가이드라인

1. **`this`에 함부로 상태를 추가하지 마십시오**:
   - 데이터나 상태 변수가 필요하다면 해당 도메인을 담당하는 Manager 클래스 내부에 정의하십시오.
2. **새로운 메시지가 필요할 때**:
   - `WorkerBridge`를 수정하지 않고, Worker가 emit하는 타입을 도메인 매니저에서 `this._bridge.on('새이벤트', ...)`로 구독하십시오.
3. **UI 컴포넌트의 자율성 보장**:
   - `Indicator`가 자신의 서브 뷰 초기화(`resetProfile()`)를 스스로 처리하게 하고, 매니저가 자신의 카드 리셋(`clear()`)을 처리하게 하십시오.
4. **테스트 견고성 유지**:
   - 소스 코드를 문자열 슬라이싱하는 취약한 테스트 방식은 지양하고, 새로 분리된 모듈의 인스턴스를 직접 생성하여 입력과 출력을 검증하는 단위 테스트를 작성하십시오.

## 현재 구현과 적용 범위

실제 모듈 지도, 이벤트 흐름, 검증 방법과 모듈 경계는 [ARCHITECTURE.md](ARCHITECTURE.md)를 기준으로 합니다. 메인 믹스인과 중복 메시지 라우팅은 제거했으며, 세션·초기화·화면 효과·워커 명령·프로필 및 클러스터 조회·메모 저장과 입력·채팅 연결 입력·패널 배치·로그타임 계산을 각각의 책임에 맞게 분리했습니다. 비동기 조회는 자신이 만든 타이머와 웹뷰의 정리까지 책임집니다. 전체 재작성이나 줄 수 감소 자체를 목표로 삼지 않습니다.
