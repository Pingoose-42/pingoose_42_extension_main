# 설치 방식과 검증

## 사용자 진입점

GNOME 42 데스크톱 터미널에서 sudo 없이 실행합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/Pingoose-42/pingoose_42_extension_main/main/install.sh | bash
```

설치기를 파일로 저장해 읽은 뒤 실행해도 같은 방식으로 동작합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/Pingoose-42/pingoose_42_extension_main/main/install.sh -o pingoose-install.sh
bash pingoose-install.sh
```

특정 버전은 다음처럼 선택합니다. 대상 버전에도 새 설치기와 압축 설치 지원이 들어 있어야 합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/Pingoose-42/pingoose_42_extension_main/main/install.sh | bash -s -- --ref <브랜치·태그·커밋>
```

로컬 소스가 있는 개발자는 기존처럼 `./install.sh`를 실행합니다. `--ref`를 주지 않으면 해당 소스를 설치하며, 다른 소스를 다운로드하지 않습니다. 설치·업데이트는 GNOME 세션을 재시작하거나 확장을 자동 활성화하지 않습니다. 설치 후 README의 세션 재시작·활성화 절차를 따릅니다.

## 대표 설치기와의 비교

[uv](https://docs.astral.sh/uv/getting-started/installation/)는 `curl … | sh` 형태의 독립 설치기를 제공하고, [rustup](https://github.com/rust-lang/rustup/blob/master/rustup-init.sh)은 작은 셸 스크립트가 임시 디렉터리에 실제 설치기를 받아 실행합니다. 사용자가 개발용 Git 저장소를 준비할 필요가 없다는 점이 공통입니다.

Pingoose도 독립 셸 진입점, 임시 다운로드, 실패 종료 코드, 완료 후 정리를 제공합니다. 다운로드를 시작하기 전에 셸 함수 전체가 정의되도록 하며, 실패한 curl 요청 뒤에 설치를 계속하지 않습니다. 내부 curl 다운로드는 HTTPS와 HTTPS 리다이렉트만 허용하고 연결·전체 요청 시간 제한 및 재시도를 사용합니다.

uv와 rustup은 배포된 실행 파일을 받습니다. 이번 Pingoose 구현은 기존 GNOME 패키징 절차를 재사용하기 위해 **특정 커밋의 소스 압축 파일**을 받습니다. Git 이력·클론·Git 실행 파일은 필요하지 않지만, GNOME 패키징에 필요한 기존 명령과 GI 라이브러리는 그대로 필요합니다. 미리 만든 `.shell-extension.zip` 릴리스를 직접 받는 배포까지 추가한 것은 아닙니다.

## 최초 설치와 업데이트가 공유하는 경로

1. 부트스트랩은 GitHub API에서 선택한 참조의 커밋 SHA를 확인합니다.
2. 같은 SHA에 있는 Python 설치 도우미를 받습니다. 이 도우미는 설치된 Pingoose의 설정이나 업데이트 후보 상태 없이 최초 설치를 수행할 수 있습니다.
3. `download_source()`가 `https://codeload.github.com/<owner>/<repo>/tar.gz/<SHA>`를 다운로드합니다. 업데이트에서는 이미 승인한 SHA를 그대로 사용합니다.
4. 아카이브의 최상위 이름과 경로를 검사하고 일반 파일·디렉터리만 새 임시 소스 경로에 풉니다. 경로 이탈, 심볼릭 링크·하드링크·특수 파일, 중복 파일 및 크기·항목 수 제한 위반은 설치 전에 실패합니다.
5. 임시 소스 루트에 저장소·참조·SHA를 기록하고 선택한 저장소·참조를 번들 업데이트 기본값으로 저장한 뒤 `src/scripts/install.sh`를 실행합니다. 따라서 `--ref`로 설치한 브랜치는 다음 업데이트에도 유지됩니다. 기존 GNOME 버전·세션·의존성 검사는 설치 파일을 교체하기 전에 수행합니다.
6. 설치 패키지의 `config/installed.json`에도 같은 출처와 SHA를 기록합니다. `.git`이 없는 설치도 다음 업데이트 확인에서 실제 설치 버전으로 인식합니다.
7. 설치가 성공한 뒤에만 업데이트 상태를 진전시키며, 실패해도 임시 소스와 다운로드는 정리합니다.

설치·업데이트의 다운로드 출처는 GitHub의 HTTPS 서비스입니다. SHA 고정은 브랜치 이동에 따른 버전 변경을 방지하며, 독립적인 서명이나 별도 배포 체크섬 검증을 추가한 것은 아닙니다. 전체 네트워크 설치는 인터넷과 GitHub API 접근이 필요합니다.

## 검증

`bash src/scripts/test.sh`가 다음을 포함합니다.

- stdin에서 실행하는 셸 설치기, 로컬 설치, 슬래시가 있는 참조, 실패 종료 코드 및 임시 파일 정리
- 승인 후 브랜치가 이동해도 고정한 SHA의 압축 파일만 설치하는 회귀 테스트
- Git 없는 압축 설치와 출처 기록, 다음 업데이트 검사에서 같은 버전을 재설치하지 않는 회귀 테스트
- 잘못된 아카이브 경로·링크·누락된 설치기·손상된 다운로드·크기 제한 거부
- 다운로드·설치 실패 시 기존 업데이트 상태 보존

테스트의 다운로드 응답과 설치 대상은 임시 fixture로 대체합니다. 실제 GNOME 세션이나 사용자의 확장을 설치·재시작하지 않습니다. 실제 GNOME 42에서의 화면 동작과 설치는 별도 데스크톱 확인이 필요합니다.
