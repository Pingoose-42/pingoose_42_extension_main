# Pingoose 코드 아키텍처

Pingoose는 GNOME Shell UI와 별도 GTK/WebKit 워커로 실행됩니다. 설정 창은 GTK 환경에서 실행됩니다. Shell, 설정 창, 워커는 각자의 실행 환경을 유지하며, 순수 모델과 저장 서비스만 필요한 범위에서 공유합니다.

## 책임과 소유권

| 영역 | 책임 | 주요 파일 |
| --- | --- | --- |
| 진입점 | 컴포넌트 생성, 의존성 연결, 공통 시계, 종료 순서 | `src/extension.js` |
| 워커 통신 | subprocess, stdin 큐, stdout JSON 디스패치 | `services/workerBridge.js` |
| 링크 및 브라우저 | 웹뷰/기본 브라우저 선택 분기 | `services/linkOpener.js` |
| 로그인 세션 | 계정 전환, 프로필/상태 표시, 로그인 후 복원 | `services/session.js` |
| 초기화 | 워커 확인 응답과 종료 대기, 데이터 및 설정 초기화 | `services/reset.js` |
| 도메인 UI | 각 목록의 상태, 메시지 구독, 사용자 동작, 렌더링 | `ui/slots.js`, `ui/evaluations.js`, `ui/agenda.js`, `ui/notifications.js` |
| 패널 조립 | 공통 팝업 호스트, 설정 메뉴, 표시 순서, 여백과 위치 | `ui/settings.js`, `ui/visibility.js`, `ui/layout.js` |
| 화면 효과 | 플래시 액터, 밝기/간격, 타이머 수명 | `ui/screenFlash.js` |
| 순수 모델 | 슬롯/평가/아젠다 규칙, 로그타임 합산, 메모 분리 | `models/` |
| 저장 서비스 | 메모, 카드, 프로필/즐겨찾기 캐시의 파일 I/O | `services/projectNotes.js`, `cardStore.js`, `favoriteCache.js`, `profileCampusCache.js` |
| 워커 조립 | 인증 세션, 수집기 연결, 평가 상태 저장과 주기 조율 | `worker/webview.js` |
| 워커 명령 | IPC 명령 해석과 입력 검증, 명시적으로 주입한 동작 호출 | `worker/commands.js` |
| 워커 요청 | 슬롯 요청, 서비스/프로젝트 창의 개수 제한과 종료 | `worker/slots.js`, `worker/windows.js` |
| 상대 프로필 조회 | 친구·좌석 조회, 평가 상대 조회, 각 웹뷰와 타이머 취소 | `worker/chatLookup.js`, `worker/counterpartLookup.js` |
| 입력 UI | 채팅 연결 입력·진행 상태, 메모 입력·커서 스크롤 | `ui/chatConnection.js`, `ui/noteEditor.js` |
| 워커 수집기 | 아젠다, 클러스터 JSON, 프로필 DOM 수집 | `worker/agenda.js`, `worker/clusters.js`, `worker/profile.js` |
| 설정 UI | GTK 설정 화면과 관리 창 | `prefs.js`, `preferences/` |

`extension.js`는 더 이상 UI 컨트롤러의 prototype을 복사하지 않습니다. 각 매니저를 생성하고 명시적인 메서드와 콜백으로 연결합니다. 다른 도메인의 내부 배열을 진입점에서 수정하거나 통신 메시지를 다시 전달하지 않습니다.

## 메시지와 상태 흐름

1. 워커가 stdout에 JSON 한 줄을 보냅니다.
2. `WorkerBridge`가 해당 `type`을 한 번 발행합니다.
3. 각 도메인 매니저가 자신이 구독한 메시지만 처리합니다. 아젠다 스냅샷은 아젠다 매니저가 캘린더 서비스에도 전달합니다.
4. 로그인 전환과 프로필 표시는 `session` 서비스가 담당합니다. 로그아웃 시 진입점에서 주입한 정리 콜백이 각 컴포넌트의 `clear`/`reset`을 호출합니다.
5. UI 요청은 `bridge.send()`와 워커의 `commands.Router`를 거칩니다. 라우터는 워커 객체를 통째로 받지 않고 명령별 콜백을 받습니다. 창을 표시하는 요청의 입력 이벤트 시각도 이 경로에서 보존합니다.

초기화 중에는 워커의 일반 데이터 메시지를 받지 않고 `reset-ready`/`reset-error`만 처리합니다. 프로세스 종료 이벤트는 stdout을 끝까지 읽은 뒤 전달해 마지막 확인 응답을 놓치지 않습니다. 이전 프로세스의 늦은 읽기 응답은 무시합니다.

슬롯 매니저는 로그인 후와 15분 경계에서 접힘 여부와 무관하게 조회합니다. 로그아웃 검사는 슬롯과 평가 스냅샷을 모두 기다립니다. 평가 카드의 완료 판정은 `models/evaluationFeedback.js`, `models/evaluationState.js`, `services/evaluationFeedback.js`의 규칙을 따릅니다.

## 알림, 캘린더, 캐시

- 시작 전 알림은 `models/startReminders.js`에서 후보를 계산하고 `services/startReminders.js`에서 설정과 발송 이력을 적용합니다. 아젠다는 `subscribed === true`인 일정만 대상입니다. 평가자는 역할에 관계없이 평가 알림 대상입니다.
- 새 아젠다 발견 알림과 시작 전 알림은 별개입니다. 미작성 피드백은 `/events/unfeedbacked` 스냅샷으로 확인하고 `agenda-feedback:<id>` 알림을 별도로 보냅니다. `agendaFeedbackIds` 이력은 기존 상태 파일과 평가 상태에 함께 유지하며, 이전 파일에 필드가 없으면 빈 이력으로 읽습니다. 피드백 배너는 새 일정 즉시 알림 설정과 무관하지만 아젠다 시스템 알림 설정은 따릅니다.
- 캘린더 이력 병합은 `models/agendaCalendar.js`가 담당합니다. 이미 시작한 일정은 서버 목록 누락·구독 표시 변경에도 보존하며, 기본 꺼짐인 자동 삭제 옵션을 켠 경우에만 종료된 일정을 동기화에서 제외합니다. 예정 일정의 구독 취소와 관리 창의 명시적 삭제는 별도로 적용합니다.
- 알림 매니저는 카드 저장과 배너 정책을 소유하고, 화면 플래시는 별도 컨트롤러에 위임합니다. 아젠다 피드백의 Write Feedback 버튼은 카드·배너에서 같은 액션을 사용합니다. 아젠다 카드와 알림은 `models/agenda.js`의 `agendaFeedbackUrl()`을 공유합니다. [Intra Home 위젯의 Feedback 링크](https://profile-v3.intra.42.fr/assets/Home-3667200d.js)와 동일하게 `https://projects.intra.42.fr/events/<id>/feedbacks/new`를 기존 `service:open` 경로로 엽니다. 구독 ID나 행사/시험 종류가 아니라 일정 ID를 사용하며, 클릭으로 피드백 완료나 카드 삭제를 처리하지 않습니다.
- 저장된 테스트 평가 복원은 알림 매니저가 주입받은 `restoreTests` 콜백으로 평가 매니저에 전달합니다.
- 로그타임 합산은 `models/logtime.js`의 순수 계산입니다. 워커는 서버 응답과 설정값을 전달합니다.
- 메모의 개별 할 일 분리와 그룹화는 `models/projectNotes.js`, 파일 권한·원자적 저장·읽기는 `services/projectNotes.js`에 있습니다. 기존 저장 경로와 형식은 유지합니다.
- 클러스터 수집기는 Meta 쿠키만 사용하고 프로필 bearer 토큰을 전송하지 않습니다. 캠퍼스 캐시와 요청 취소는 수집기가 소유합니다.
- 평가 상대 조회는 캐시된 이름과 사진을 재사용하고 좌석 상태만 갱신합니다. 동일 평가의 중복 조회와 느린 DOM 응답의 중복 요청을 막습니다. `models/counterpart.js`는 아직 유효한 평가에만 조회 결과를 반영하고, 명확한 오프라인 결과가 없으면 확인된 좌석을 유지합니다.
- 채팅 패널은 연결 입력을 `chatConnection`에 맡깁니다. 즐겨찾기는 `connectUser()`와 `connecting`을 사용하며 연결 대기 상태를 직접 수정하지 않습니다.
- 프로젝트 패널은 저장과 목록을 소유하고, `noteEditor`는 입력 액터·Enter 처리·줄 번호·커서 스크롤을 소유합니다. 길이와 줄바꿈 측정은 기존 `noteTextLayout`을 공유합니다.

## 수명 주기

새 컴포넌트는 자신이 만든 시그널, 타이머, 팝업, 액터와 구독을 `destroy()`에서 정리해야 합니다. 진입점은 공통 타이머와 세션 훅을 먼저 중단하고, 서비스 및 뷰를 정리한 뒤 브리지와 인디케이터를 파괴합니다. 초기화 시에도 호출되는 컴포넌트의 종료 메서드는 중복 호출을 견뎌야 합니다.

로그아웃과 종료 시 워커는 조회 컴포넌트의 `clear()`를 호출합니다. 컴포넌트가 타이머와 웹뷰를 정리하고 늦은 콜백을 무시합니다. 평가가 삭제·변경된 뒤 도착한 사진 응답은 캐시 파일을 다시 만들지 않습니다. 슬롯 조회 결과도 시작한 인증 세션에만 반영합니다.

`layout`은 공통 패널 호스트와 패널 재배치를 소유합니다. 채팅·서비스·메모 패널은 준비된 호스트에 자신의 액터만 추가합니다. 종료 시 팝업의 원래 닫기 콜백을 복원합니다.

Shell 전용 `St`·`Main`을 워커에서 가져오지 않습니다. 인증 정보는 워커 내부에서만 사용하고 IPC나 로그에 넣지 않습니다. 저장 경로 및 GSettings 키를 바꿀 때는 기존 데이터 호환성을 별도로 검증합니다.

## 검증과 포맷

```sh
bash src/scripts/test.sh
bash src/scripts/test.sh --sockets

# 선택형 개발 도구: 설치된 익스텐션에는 Node 패키지가 필요하지 않습니다.
npm ci --ignore-scripts
npm run format:check
npm run format
```

`.prettierrc.json`은 4칸 들여쓰기, 100열 기준 줄바꿈을 정의합니다. 주입되는 WebKit 스크립트 문자열은 자동 재해석하지 않습니다.

새 테스트는 `src/tests/helpers.cjs`로 실제 GJS 모듈을 로드하고 플랫폼 의존성만 대체합니다. 메시지 중복, 초기화 응답/종료 순서, 구독 상태와 알림 중복 방지, 조회 취소와 캐시 재사용, 연결 입력, 커서 스크롤과 타이머 정리를 검증합니다. 과거 테스트 일부는 아직 소스 일부를 추출합니다. 해당 영역을 변경할 때 모듈 단위 테스트로 옮기며, 테스트를 통과시키기 위해 런타임 호환 코드를 남기지 않습니다.

## 모듈 경계 유지

`worker/webview.js`에는 인증 세션과 주기 조율을 남깁니다. 조회별 웹뷰 수명은 수집기에, 상태 변환은 모델에, 입력 액터는 입력 컴포넌트에 둡니다. 파일 크기를 줄이기 위해 원래 객체 전체를 주입하거나 prototype 믹스인을 다시 도입하지 않습니다.

플랫폼 대체 객체를 사용하는 테스트는 상태 전이와 정리를 검증합니다. 실제 폰트 배치는 `gjs src/tests/note-text-layout.js`로 별도 검사할 수 있습니다. GNOME Shell의 실제 팝업·IME·창 배치는 설치 후 UI 검증 대상이며, 단위 테스트 통과만으로 실사용 UI 검증을 대체하지 않습니다.

## 설치 및 업데이트

루트 `install.sh`는 로컬에서는 `src/scripts/install.sh`로 설치합니다. 단독 실행 시에는 원격 `main`의 커밋 SHA와 `worker/updater.py`를 받아 bootstrap을 실행합니다. 소스의 `.pingoose-source.json`은 설치 시 `config/installed.json`의 버전 기준이 됩니다. 업데이트 카드에는 커밋 메시지를 표시하고 빈 줄 뒤에 세션 리로드 안내를 둡니다.
