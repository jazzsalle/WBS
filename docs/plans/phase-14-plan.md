# Phase 14 구현 계획 (planner 산출, 2026-09-25) — 재개용

결정 4건(2026-09-25 확정, SOT 반영): ① 과제 개요 [과제 삭제] 2단계 확인을 T7로 신설(§7.3·TU-5) ② `createSampleProject` 실패 분기에 `projectId` 덧붙인 확장 반환형(TU-3) ③ 도움말·튜토리얼 본문에 상대 링크 금지, `HELP_RELATED`·`lib/tutorial.ts`로 UI가 링크를 그림(HP-6·TU-7) ④ 튜토리얼 md 형식 `# 단계명` / `> 할 일:` / `## 버튼은 어디에` / `## 완료되면`.

사전 조사: `lib/notes.ts`는 표 미지원·상대 링크 텍스트 강등. 서버 액션이 다른 액션을 부르는 관례 있음(board·gantt → tasks·milestones) → `createSampleProject`는 기존 액션 순서 호출로 H-8·PL-10·PL-D1 자동 준수. `lastBackupAt`은 클라이언트 LocalConfig → ⑨ 자동 판정은 클라이언트. 미들웨어가 `/help`를 이미 가드.

## 태스크
- **[P] T1 LocalConfig.tutorial** — `types/index.ts`(`LocalConfig.tutorial`·`TutorialStepId`), `lib/local-config.ts`(기본값, Zod `.catch` 필드별, `parseStoredLocalConfig` export), `tests/unit/local-config.test.ts`(구 파일·타입 오류·모르는 id 복구, onboardingCompleted 유지)
- **[P] T2 도움말 인프라** — `lib/help.ts`(HELP_SLUGS 17·HELP_TOC_GROUPS·HELP_RELATED·`helpSlugForPath`·`parseHelpHead`), `lib/content.ts`(서버 fs 로더, 없으면 throw), `actions/help.ts`(`getHelpDocument`), `MarkdownViewer` props 확장(`blocks?`), `app/help/page.tsx`+`components/help/HelpPage.tsx`(목차·해시·강조·관련 도움말), `components/help/HelpLink.tsx`·`ProjectHelpLink.tsx`, `next.config.ts` `./content/**`, `tests/unit/help.test.ts`·`help-content.test.ts`(17 slug·HP-6·표 0·상대링크 0·3,500자·tutorial 9편 형식·next.config 포함)
- **[P] T3a~d 도움말 본문** — a: dashboard·projects·project·wbs·gantt / b: board·goals·milestones·team·risks·notes·todos / c: budget·budget-rules / d: settings·calculations·faq. 형식 HP-6, 수치에 SOT §·부록 D 조문
- **[AFTER T1] T4 튜토리얼 레지스트리 + 본문 9편** — `lib/tutorial.ts`(TUTORIAL_STEPS 9·`stepForPath`·`mergeStepStatus`·`isSampleProject`·상수), `content/tutorial/*.md` 9편, `tests/unit/tutorial.test.ts`
- **[AFTER T1,T2] T5 액션** — `actions/help.ts`에 `getTutorialStatus(projectId|null)`(리포지토리 조회 7단계, null/없음 → projectExists false)·`createSampleProject(existingId)`(기존 액션 순서: createProject → updateYear/createYear → createOrganization lead·joint → createMember×4·setProjectPM → createTask×8 깊이3 → createDeliverable×2·createTechTarget → generateDefaultMilestones → createBudgetDetail×6 → applyRulePreset moe_energy_sme fill; 부분 실패 확장 반환), `tests/integration/tutorial-actions.test.ts`·`tutorial-partial.test.ts`(applyRulePreset mock 실패)
- **[P] T7 [과제 삭제]** — `components/project/DeleteProjectButton.tsx`(2단계), `app/projects/[id]/page.tsx` 마운트
- **[AFTER T4,T5] T6 튜토리얼 UI** — `components/tutorial/TutorialLauncher.tsx`·`TutorialPanel.tsx`·`StepItem.tsx`, `components/settings/TutorialResetPanel.tsx`. LocalConfig만 씀
- **[AFTER T2,T6,T7] T8 배선·검증** — 헤더 `?` 5곳, 드로어 마운트(대시보드·과제 레이아웃), 설정에 TutorialResetPanel, `ProjectList` 예제 배지, npm test·tsc·build·standalone content 확인

의존: T1→T4→T6; T1+T2→T5→T6; T3a~d ∥ T7; T2+T6+T7→T8.
