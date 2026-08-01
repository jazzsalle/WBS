---
name: handoff
description: 자리를 뜨기 전 인계 기록을 남긴다. PROGRESS.md 갱신 + 커밋. /handoff로 호출.
disable-model-invocation: true
---

# 인계 (handoff)

떠나기 전 다음 순서로 인계를 남긴다:

1. **이번 세션에서 한 일을 되짚는다** — 대화 내용, `git status`, `git log --oneline -5`.
2. **`PROGRESS.md`를 아래 섹션 구조로 갱신한다** (전부 사실 진술로, 다음 사람이 이 파일만 보고 이어갈 수 있게):
   - `## Last updated` — 오늘 날짜 + 작성 위치(회사/집 등 알 수 있으면)
   - `## Current goal` — 지금 향하고 있는 목표 한 줄
   - `## Done this session` — 이번 세션 완료 항목 (커밋 해시 병기)
   - `## In progress` — 하다 만 것과 현재 상태 (없으면 "없음")
   - `## Next steps` — 다음에 할 일, 구체적 순서로
   - `## Blockers` — 막힌 것 / 사용자 결정 대기 (없으면 "없음")
   - `## How to run` — 빌드·테스트·실행 명령 (바뀐 것 있으면 갱신)
3. `git add -A && git commit` — 커밋 메시지는 인계 내용 요약으로.
4. **push는 하지 않는다.** "`git push` 후 자리를 뜨세요"라고 안내만 한다.
