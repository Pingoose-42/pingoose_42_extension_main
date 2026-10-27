# 코드 구조와 개발 안내

Pingoose는 GNOME Shell 확장과 별도의 WebKit 작업 프로세스로 실행됩니다. Shell 쪽은 메뉴와 패널을 그리며, WebKit 작업 프로세스는 Intra 로그인과 서버 조회를 담당합니다. 두 프로세스 사이에는 명령과 JSON 메시지가 오갑니다.

## 먼저 읽을 파일

| 진입점 | 책임 |
| --- | --- |
| `src/extension.js` | 확장 활성화·종료, 컨트롤러 구성, 작업 프로세스 생성과 메시지 전달 |
| `src/ui/indicator.js` | 탑바와 메인 패널의 기본 구성 |
| `src/worker/webview.js` | GTK/WebKit 생명주기, 인증, 명령 처리와 조회 일정 |
| `src/prefs.js` | 설정 창 진입점 |

`extension.js` 하단에서 `ui/*`의 `Controller` 메서드를 확장 클래스에 연결합니다. 이 컨트롤러들은 별도 객체가 아니라 확장의 상태와 생명주기를 공유합니다. 반면 `ChatPanel`, `ProjectPanel`, `ServicePanel`은 자체 상태를 가진 객체입니다. 코드를 이동할 때 두 방식을 혼동하지 않아야 합니다.

## 디렉토리별 역할

| 디렉토리 | 내용 |
| --- | --- |
| `src/models/` | 데이터 검증, 일정·구독 규칙, 표시값 계산과 저장 형식 |
| `src/ui/` | GNOME Shell 메뉴, 카드, 패널과 대화상자 |
| `src/services/` | 소켓 통신, 슬롯 요청, 저장소와 시스템 세션 연동 |
| `src/worker/` | 별도 프로세스의 WebKit·HTTP 처리 및 DOM 읽기 |
| `src/preferences/` | 설정 페이지별 UI |
| `src/schemas/` | GSettings 키, 기본값과 자료형 |
| `src/assets/` | 아이콘 및 애니메이션 이미지 |
| `src/tests/` | 모델·흐름 회귀 테스트와 로컬 소켓 테스트 |
| `src/scripts/` | 테스트, 패키지 생성 및 설치 스크립트 |

`models`의 모든 파일이 순수 함수만 포함하는 것은 아닙니다. 예를 들어 `projectNotes.js`는 로컬 파일 저장을 포함합니다. 새 계산·검증 로직은 가능하면 UI·네트워크 없이 실행할 수 있도록 작성합니다.

## 기능별 수정 위치

| 기능 | 데이터·통신 | 화면 |
| --- | --- | --- |
| 아젠다 | `models/agenda.js`, `worker/agenda.js` | `ui/agenda.js` |
| 평가 | `models/evaluations.js`, `worker/webview.js` | `ui/evaluations.js` |
| 평가 슬롯 | `models/slotSchedule.js`, `services/slotsService.js` | `ui/slots.js` |
| 채팅 | `models/chatPolicy.js`, `services/chat.js` | `ui/chatPanel.js` |
| 업데이트 | `worker/updater.py`, `config/update.json` | `services/updater.js`, `preferences/general.js` |
| 로그아웃 확인 | `services/systemSessionHook.js` | `ui/logoutDialog.js` |
| 프로필·학습시간 | `worker/profile.js`, `worker/webview.js` | `ui/indicator.js` |
| 프로젝트 메모 | `models/projectNotes.js` | `ui/projectPanel.js`, `preferences/projects.js` |
| 서비스 웹뷰 | `models/serviceSites.js`, `worker/serviceBrowser.js` | `ui/servicePanel.js` |
| 알림 | `services/cardStore.js` | `ui/notifications.js`, `preferences/notifications.js` |

### 아젠다 흐름

1. `webview.js`가 인증과 공통 HTTP 세션을 관리하고 `AgendaClient.poll()`을 호출합니다.
2. `worker/agenda.js`가 일정 목록과 미작성 피드백 목록을 조회합니다. 두 응답이 모두 성공해야 화면 데이터를 교체합니다.
3. `models/agenda.js`가 서버 응답을 검증·정규화하고 구독 가능 여부를 계산합니다.
4. 작업 프로세스가 `agenda` 메시지를 보내면 Shell의 `ui/agenda.js`가 카드를 그립니다.
5. 구독 변경 시에는 서버 목록을 먼저 다시 조회한 후 최신 구독 ID로 요청합니다.

`AgendaClient`는 진행 중인 조회·구독 변경과 다음 조회 시각을 소유합니다. 인증, 공통 요청 제한 시각, HTTP 세션, 저장소, 새로고침 결과는 전달받은 Worker를 통해 사용합니다. `emit`, `now`, `isStopped`는 생성자에 주입하므로 실제 네트워크 없이 요청 흐름을 테스트할 수 있습니다. 계정이 바뀌거나 프로세스가 종료된 뒤 도착한 응답은 반영하지 않습니다.

### 채팅 흐름

`services/chat.js`가 연결 및 핸드셰이크를 담당하고 `ui/chatPanel.js`는 서비스 이벤트를 받아 화면을 갱신합니다. 패널 생성과 세션 초기화 모두 `_bindChatSignals()`를 통해 같은 이벤트를 연결합니다. 새 연결은 확인 전까지 목록에서 숨기고, `connection-ready` 후에 표시합니다. 이미 열려 있던 대화의 재연결 실패가 기존 대화 기록을 삭제해서는 안 됩니다.

### 로그아웃 흐름

`SystemSessionHook`이 슬롯과 평가 상태를 확인하고, `SlotConfirmDialog`가 내용을 표시한 뒤 선택 결과를 돌려줍니다. 실제 슬롯 닫기·로그아웃 진행은 서비스의 책임이고, 카운트다운과 버튼 배치는 UI의 책임입니다.

## 검증과 패키징

프로젝트 루트에서 실행합니다.

```sh
bash src/scripts/test.sh
```

JavaScript 문법 검사, Node·Python 기반 회귀 테스트, GSettings 스키마 검증을 실행합니다. 테스트는 GNOME Shell 화면을 직접 구동하지 않으며, 일부 기존 테스트는 VM에서 필요한 메서드를 추출해 실행합니다. 아젠다 요청 테스트는 분리된 모듈 전체를 로드하고 HTTP 응답을 모의합니다.

실제 로컬 소켓의 핸드셰이크·메시지·연결 거절도 검증하려면:

```sh
bash src/scripts/test.sh --sockets
```

소켓 테스트는 GJS와 로컬 포트 사용 권한이 필요하며 캠퍼스의 다른 좌석에는 접속하지 않습니다. UI 변경은 GNOME Shell 42에서 별도로 확인합니다.

```sh
bash src/scripts/package.sh /tmp/pingoose-package
bash src/scripts/install.sh
```

패키지 스크립트는 런타임 디렉토리를 포함합니다. 새 런타임 최상위 디렉토리를 추가하면 `package.sh`와 `install.sh`의 `--extra-source` 목록도 함께 확인합니다. 업데이트 설정의 `config` 디렉토리도 패키지에 포함됩니다. 설치는 GNOME 세션을 자동 재시작하지 않습니다.

루트 `install.sh`는 로컬 소스 설치와 `curl | bash` 설치를 지원합니다. 원격 설치와 업데이트는 `worker/updater.py`의 `download_source()`와 `install_source()`를 공유하며, 커밋 SHA로 고정한 압축 파일을 사용합니다. `source_receipt()`는 임시 소스 루트의 `.pingoose-source.json` 또는 로컬 Git 커밋에서 설치 출처를 읽어 패키지의 `config/installed.json`에 기록합니다.

## 변경 시 지킬 경계

- Shell 전용 `St`·`Main` 모듈을 독립 실행되는 `worker`에 가져오지 않습니다.
- 서버 파싱과 구독·시간 계산은 화면 렌더링에서 분리합니다.
- 비동기 요청은 계정 변경, 종료, 중복 요청과 늦은 응답을 고려합니다.
- 인증 헤더는 작업 프로세스 내부에서만 사용하고 메시지나 로그에 넣지 않습니다.
- GSettings 키와 저장 형식을 바꿀 때는 기존 사용자 데이터의 호환성을 확인합니다.
- GJS 42의 `imports` 방식에 맞춰 모듈을 작성합니다. Node 테스트용 `module.exports`는 GJS에서 실행되지 않도록 조건부로 둡니다.
