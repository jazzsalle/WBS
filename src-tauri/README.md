# Tauri 데스크톱 셸 (SOT §14.1)

Next.js standalone 빌드를 **랜덤 포트** 사이드카(`node server.js`)로 띄우고,
WebView가 `http://127.0.0.1:{port}`에 접속한다. `wbs://` 딥링크로 OAuth 콜백을 받는다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/main.rs` | 플러그인 등록(single-instance → deep-link 순), dev/prod 분기 |
| `src/sidecar.rs` | 랜덤 포트 할당 → `node server.js` 기동 → 준비 폴링 → WebView 네비게이트, 종료 시 kill |
| `src/keychain.rs` | 세션 토큰 OS 키체인 커맨드 (keyring 크레이트, A-4·C-3) |
| `scripts/prepare-sidecar.mjs` | standalone 산출물 + 빌드 머신 node.exe를 `resources/`로 복사, service_role 유출 검사 |
| `frontend-dist/index.html` | 사이드카 준비 전 로딩 화면 |
| `capabilities/default.json` | 사이드카 원격 출처(`http://127.0.0.1:*`)에 IPC 허용 + opener/fs/dialog 권한 |

## 플러그인

| 플러그인 | 용도 | 권한 (capabilities/default.json) |
|---|---|---|
| `tauri-plugin-deep-link` | `wbs://` OAuth 콜백 (A-1) | `deep-link:default` |
| `tauri-plugin-single-instance` | 두 번째 인스턴스 argv를 딥링크 이벤트로 전달 | — |
| `tauri-plugin-opener` | OAuth URL 시스템 브라우저 열기 — 프론트가 `plugin:opener\|open_url` invoke (JS 래퍼 없음) | `opener:allow-open-url` |
| `tauri-plugin-fs` | 백업 파일 쓰기·목록·삭제(§8.7 K-1·K-3) + LocalConfig 저장(§5.16) | `fs:allow-*` 6종 + `fs:scope` 전체(`**`) — 백업 폴더가 사용자 임의 경로라 좁힐 수 없다 |
| `tauri-plugin-dialog` | 백업 폴더 선택 대화상자 (§7.14) | `dialog:allow-open` |

사이드카 실행 방식: 사용자 PC에 Node 설치를 요구하지 않기 위해 **빌드 머신의 node
실행 파일을 리소스로 동봉**한다. externalBin 대신 리소스 + `std::process`를 쓴다
(shell 플러그인 권한 없이 포트 전달·수명 관리를 직접 통제).

## 빌드·검증 (수동 단계 — Rust 툴체인 필요)

이 저장소를 만든 환경에는 Rust가 없어 cargo 검증을 하지 못했다. Rust 설치 후:

```powershell
winget install Rustlang.Rustup   # 이후 rustup default stable-msvc
cd src-tauri; cargo check        # 컴파일 검증
cd ..; npm run tauri:dev         # 개발 실행 (next dev + 창)
npm run tauri:build              # msi/nsis 번들 (beforeBuildCommand가 사이드카 리소스 준비)
```

딥링크 확인: 앱 실행 상태에서 `start "wbs://auth-callback?code=test"` →
두 번째 인스턴스가 기존 창에 전달하고, 프론트 `onDeepLink` 리스너 콘솔에
`[deep-link] 딥링크 1건 수신`이 찍히면 정상.

### 백업·플러그인 실기동 검증 (이 저장소에서 cargo 검증 불가 — Rust 설치 후 수행)

1. `cd src-tauri; cargo check` — opener/fs/dialog 플러그인 추가 후 컴파일 확인
2. `npm run tauri:dev` → 로그인 화면에서 [회사 구글 계정으로 로그인] → 시스템
   브라우저가 열리면 opener 정상 (`plugin:opener|open_url` 권한 확인)
3. 온보딩 모달에서 백업 폴더 입력 → 앱 재시작 시 온보딩이 다시 뜨지 않으면
   LocalConfig(app config dir의 `local-config.json`) 저장 정상
4. 설정 → 백업·복원 → [지금 내보내기] → 지정 폴더에
   `wbs-backup-<ISO시각>.json` 생성 확인 (fs 쓰기 권한)
5. [백업 폴더 변경] → 폴더 선택 대화상자가 뜨면 dialog 정상
6. 백업을 13회 반복 → 폴더에 12개만 남고 가장 오래된 파일이 지워지면 K-3 정상
7. `local-config.json`의 `lastBackupAt`을 8일 전으로 수정 후 앱 재시작 →
   "자동 백업 완료" 알림 + 새 백업 파일 생성이면 K-2 정상
8. [복원] → 백업 파일 선택 → 2단계 확인 → 복원 완료 + 복원 직전 백업 파일이
   폴더에 추가로 생기면 K-4 정상. schemaVersion을 수정한 파일은 거부(K-5) 확인

코드 서명은 하지 않는다 — SmartScreen 경고는 감수한다 (§14.1).
