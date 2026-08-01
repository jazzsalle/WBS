---
name: phase-run
description: /phase-run N 또는 "Phase N 실행"/"Phase N 시작" 요청 시 호출. Phase를 planner로 분해하고 generator를 병렬 디스패치한 뒤 evaluator로 검증하는 오케스트레이션.
allowed-tools: Read, Edit, Write, Bash(git *), Task
---

# Phase 오케스트레이션

`$ARGUMENTS`에 Phase 번호가 온다 (예: `0`, `0.5`, `1`). 번호가 없으면 `PROGRESS.md`의 Next steps에서 다음 Phase를 추론하고 사용자에게 확인받는다.

메인 세션인 당신이 직접 오케스트레이션한다. 순서:

## a) 계획

`@planner` subagent에게 Phase N 분해를 맡긴다. 프롬프트에 포함할 것: Phase 번호, `CLAUDE.md` Phase 표의 해당 행(목표·산출물·SOT 참조), `evaluation_criteria.md`의 해당 체크리스트.

계획이 나오면 태스크 목록을 사용자에게 짧게 보여주고 진행한다 (승인 대기는 하지 않되, 이상해 보이면 사용자가 끊을 수 있게).

## b) 병렬 디스패치

- `[PARALLEL]` 태스크들: 각각 `@generator`를 **Task 도구로 동시에**(한 메시지에 여러 Task 호출) 띄운다. 병렬화는 generator 내부가 아니라 여기서 Task를 여러 개 띄우는 방식이다.
- `[AFTER: X]` 태스크: 선행 태스크 완료 후 순차 실행.
- 각 generator에게는 **자기 태스크 명세 전문**(목표·대상 파일·완료 기준·SOT 근거)을 그대로 전달한다.
- 같은 파일을 건드리는 태스크를 동시에 띄우지 않는다 — planner 표기가 틀렸다고 판단되면 순차로 강등한다.

## c) 검증

전 태스크 완료 후 `@evaluator`에게 Phase N 채점을 맡긴다.

## d) FAIL 처리

거절 노트를 해당 `@generator`에게 그대로 전달해 수정시킨다. **최대 3회 반복.** 3회 후에도 FAIL이면 멈추고 남은 문제를 사용자에게 보고한다 — 임의로 기준을 낮추지 않는다.

## e) PASS 처리 ★

1. **`PROGRESS.md`를 갱신한다** (핸드오프 장치와의 연결선 — 반드시 수행):
   - `Last updated`: 오늘 날짜
   - `Current goal`: 다음 Phase 목표
   - `Done this session`: 이번 Phase에서 만든 것 요약
   - `Next steps`: 다음 Phase 번호와 첫 작업
   - `Blockers`: 있으면 기록, 없으면 "없음"
2. "Phase N 완료"를 선언하고 결과를 요약한다.
3. 커밋 메시지를 제안하고 `git add` + `git commit`까지 한다. **push는 하지 않는다** — 사용자에게 `git push`를 안내만 한다.
