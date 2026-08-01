# Claude Code 인계 안내

## 1. 파일 배치

```
your-repo/
├── CLAUDE.md              ← 그대로 루트에
├── docs/
│   └── SOT.md             ← WBS-Tool-SOT.md 를 이 이름으로
├── samples/               ← 예산 엑셀 원본 (.gitignore 필수)
└── .gitignore
```

`CLAUDE.md`가 `docs/SOT.md`를 참조하므로 **경로와 파일명을 맞춰야 합니다.**

## 2. .gitignore

```gitignore
node_modules/
.next/
.env.local
.env*.local

# 실제 예산 자료 — 절대 커밋 금지
samples/
*.xlsx
*.xls
!tests/fixtures/*.xlsx

# Tauri
src-tauri/target/

# 백업
backups/
```

## 3. 사전 준비

- Node.js 20 이상
- Supabase 계정 + 프로젝트 1개 생성 (무료 플랜)
- Google Cloud Console에서 OAuth 클라이언트 ID 발급 (Supabase Auth에 등록)
- `.env.local`에 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

> `SUPABASE_SERVICE_ROLE_KEY`는 **넣지 않습니다.** 데스크톱 앱에 들어가면 노출됩니다.

## 4. 첫 세션 프롬프트

```
docs/SOT.md 를 읽고 Phase 0을 시작해줘.

먼저 samples/ 의 예산 엑셀 파일을 분석해서:
1. SOT §5.12 BudgetCategory에 빠진 비목이 있는지
2. SOT 부록 C 별칭 사전에 추가할 표기가 있는지
3. 헤더 위치·데이터 방향·금액 단위가 §6.8.1 감지 로직으로 잡히는지
확인하고, 필요하면 SOT를 먼저 수정한 다음 알려줘.

승인하면 supabase/migrations/ 에 전체 스키마 + RLS를 작성해줘.
```

비목 enum을 스키마에 박기 전에 실제 파일을 먼저 보게 하는 순서입니다.

## 5. Phase 순서

| Phase | 내용 |
|---|---|
| 0 | Supabase 스키마 + RLS, 타입, 리포지토리, 매퍼 |
| 0.5 | Tauri 셸, 구글 OAuth, 사용자 승인, **백업/복원** |
| 1 | 과제·단계·연차·작업 CRUD, 진척률 롤업, 우선순위 |
| 2 | 인력·기관 |
| 3 | 목표 관리 (성과·기술) |
| 4 | 마일스톤 + 대시보드 |
| 5 | 연구비 |
| 5.5 | 엑셀 임포트 |
| 6 | 리스크 + 노트 |
| 7 | 간트 + 칸반/매트릭스 |
| 8 | To-Do + 설정 + 마감 |

**Phase 4까지 가면 실사용이 시작됩니다.** 거기서 한 번 끊어 써보고 나머지를 붙이는 걸 권합니다.

## 6. 자주 틀리는 지점

| 항목 | 확인 |
|---|---|
| service_role 키 | 앱·빌드 산출물에 절대 포함 금지 |
| RLS | Phase 0부터 켜고 개발. 나중에 켜면 전부 깨짐 |
| 백업 | 무료 플랜엔 DB 백업 없음. §8.7을 Phase 0.5에 반드시 |
| 금액 | 원 단위 정수 저장. 부동소수점 금지 |
| 파생 값 | WBS 코드·진척률·우선순위 점수는 저장하지 않고 계산 |
| 리포지토리 | UI가 supabase를 직접 호출하면 NAS 이전이 막힘 |

## 7. 채팅으로 돌아올 만한 일

- 설계를 되돌아봐야 할 때 (예: 연차 계층이 실제로 불편하다)
- Supabase 한도·요금 확인
- 아키텍처 판단이 필요할 때

코드·파일 작업은 전부 Claude Code에서 하는 게 빠릅니다.
