# Phase 18 구현 계획 (메인 세션 작성, 2026-09-25) — 다크 모드

범위가 작아 planner 없이 2태스크 병렬. 조사: `bg-white` 152곳/87파일(+`bg-white/60·/70` 19곳), `text-black` 68곳(대부분 `print:text-black` 인쇄 토큰 — 유지), 인라인 헥스 22곳(`#2563eb`·`#3b82f6`·`#e2e8f0` 등 옛 Tailwind 값 — 간트·보드 SVG/inline style로 추정).

- **[P] G1 팔레트·치환** — `app/globals.css`(E.5 다크 블록 `[data-theme="dark"]` + `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` 동일 값, `@media print` 밝은 팔레트 강제), `bg-white → bg-surface`(`bg-white/60·/70` → `bg-surface/60·/70`) 전 파일 치환(**`app/layout.tsx`·`components/AppBootstrap.tsx`·`components/settings/*` 제외** — G2 소유), 인라인 헥스 → `var(--color-*)` 또는 토큰 클래스, `tests/unit/design-tokens.test.ts` 확장(다크 8×10 값 E.5 1:1, `bg-white` 0건 정적 검사, print 밝은 팔레트)
- **[P] G2 설정·적용** — `types/index.ts`·`lib/local-config.ts`(`theme` `.catch('system')`), `components/settings/ThemePanel.tsx`(개인 설정 — 라디오 3종, 즉시 적용), `app/settings/page.tsx` 마운트, `app/layout.tsx`(`<html suppressHydrationWarning>` + 인라인 스크립트: localStorage의 LocalConfig 키를 읽어 `data-theme` 세팅), `components/AppBootstrap.tsx`(Tauri: config 로드 후 `data-theme` 적용 + `matchMedia` 변화 반영), `tests/unit/local-config.test.ts` 케이스, SOT §13 9번 해소 표기
- 마감: `npm test`·tsc·build, evaluator
