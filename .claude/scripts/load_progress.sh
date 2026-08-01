#!/usr/bin/env bash
# SessionStart hook: PROGRESS.md + git 상태를 additionalContext로 주입한다.
# 내용은 명령문이 아닌 사실 진술로만 구성한다. 실패해도 세션을 막지 않는다 (항상 exit 0).
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

CONTEXT=""

if [ -f PROGRESS.md ]; then
  CONTEXT+="다음은 이 프로젝트의 인계 문서 PROGRESS.md의 현재 내용이다:\n\n"
  CONTEXT+="$(cat PROGRESS.md)\n\n"
else
  CONTEXT+="PROGRESS.md가 아직 없다.\n\n"
fi

if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  COMMITS=$(git log --oneline -5 2>/dev/null)
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  CONTEXT+="git 상태: 브랜치 ${BRANCH}, 미커밋 변경 ${DIRTY}건.\n최근 커밋 5개:\n${COMMITS}\n"
fi

# 9,000자 절단은 python 쪽에서 UTF-8 안전하게 수행한다.
# Windows는 python3가 Store 알리아스 스텁일 수 있으므로 python을 먼저 시도한다.
PYBIN=""
for cand in python python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "pass" >/dev/null 2>&1; then
    PYBIN="$cand"; break
  fi
done

# 주의: Windows python은 git-bash의 /d/... 절대 경로를 열지 못한다.
# 스크립트 첫머리에서 프로젝트 루트로 cd했으므로 상대 경로로 호출한다.
PYFILE=".claude/scripts/load_progress.py"
if [ -n "$PYBIN" ] && [ -f "$PYFILE" ]; then
  printf '%b' "$CONTEXT" | "$PYBIN" "$PYFILE" 2>/dev/null \
    || printf '%b' "$CONTEXT"
else
  # python이 없으면 plain stdout 폴백 (Claude Code가 stdout을 컨텍스트로 수집)
  printf '%b' "$CONTEXT"
fi

exit 0
