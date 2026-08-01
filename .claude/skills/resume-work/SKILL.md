---
name: resume-work
description: 사용자가 "이어서 하자", "계속", "어디까지 했지", "resume" 등 이전 작업을 이어가려 할 때 호출. PROGRESS.md와 git 상태를 읽어 중단 지점부터 재개한다. (SessionStart hook이 동작하지 않는 환경의 수동 폴백이기도 하다)
---

# 작업 재개

## 현재 인계 상태

!`cat PROGRESS.md 2>/dev/null || echo "PROGRESS.md 없음 — 첫 세션이거나 인계 기록이 없다"`

## git 상태

!`git branch --show-current && git log --oneline -5 && echo "미커밋: $(git status --porcelain | wc -l)건"`

## 재개 절차

1. 위 PROGRESS.md의 **Next steps**가 재개 지점이다. In progress 항목이 있으면 그것부터.
2. 미커밋 변경이 있으면 내용을 먼저 확인하고(끝내다 만 작업일 수 있다) 사용자에게 상태를 요약해 보고한다.
3. Next steps가 Phase 실행이면 `/phase-run N`으로 진행한다.
4. PROGRESS.md가 없거나 비어 있으면 `CLAUDE.md`의 Phase 표와 `docs/SOT.md` §11에서 다음 할 일을 추론하고 사용자에게 확인받는다.
