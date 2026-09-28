// 목표 양식 작성안내 시트 (SOT §6.17 GF-1, 부록 F-8).
//
// 워크북의 첫 시트다. 파서는 읽지 않는다. 문장은 GF-1~GF-10 규칙을 사용자 말로 풀어 쓴 것이므로 규칙이 바뀌면
// 여기도 함께 바꾼다. 격자 모양은 입력 양식 작성안내(`lib/input-form/guide.ts`)와 같다 — 어댑터가 같은 F-8
// 서식을 입히므로(`kind: 'guide'`) A1 제목·A2 부제·A4부터 2열 표라는 자리가 어긋나면 안 된다.
//
// '읽지 않는 열'은 좌표 맵에서 **생성**한다(IN-1과 같은 이유 — 하드코딩하면 열이 바뀔 때 안내가 거짓이 된다).

import type { FormCell, FormSheet } from '@/lib/input-form/types';
import { GOAL_EMPTY_INPUT_ROWS, goalSheetsFor } from './layout';
import type { GoalSheetDef } from './layout';

/** A1 제목의 `{양식 이름}` 자리(F-8) */
export const GOAL_FORM_TITLE = '성과·기술목표 양식';

/** 작성안내 표의 행 라벨. 순서가 F-8이다 */
export const GOAL_GUIDE_ROW_LABELS = ['목적', '작성 방법', '원칙', '주의', '읽지 않는 열'] as const;

function sheetName(key: 'deliverables' | 'achievements' | 'techTargets' | 'records' | 'lists' | 'meta'): string {
  return goalSheetsFor(0)[key].name;
}

/**
 * 보이는데 읽지 않는 열(F-3 키 열)을 시트별로, 숨김 id 열을 한 줄로 나열한다. 숨김 시트는 따로 한 줄.
 * 연차 수는 읽기 여부를 바꾸지 않으므로 좌표 맵은 연차 0개로 만든다.
 */
export function goalUnreadColumnsText(): string {
  const sheets = goalSheetsFor(0);
  const lines: string[] = [];
  const hiddenLabels: string[] = [];
  const hiddenSheets: string[] = [];
  for (const def of Object.values(sheets) as GoalSheetDef[]) {
    if (def.hidden) {
      hiddenSheets.push(def.name);
      continue;
    }
    const unread = def.columns.filter((c) => !c.hidden && !c.read);
    if (unread.length > 0) lines.push(`「${def.name}」 ${unread.map((c) => c.label).join(' · ')}`);
    for (const c of def.columns) if (c.hidden) hiddenLabels.push(c.label);
  }
  lines.push(
    '위 열은 연한 베이지 바탕의 수식이며 값을 고쳐도 반영되지 않습니다.',
    '각 시트 맨 아래 합계 행은 수식이며 읽지 않습니다 — 파서는 합계 행 바로 위까지만 읽습니다. 합계 행 아래에 적으면 반영이 막힙니다 — 행 삽입으로 늘리세요.',
    `숨김 열(${[...new Set(hiddenLabels)].join(' · ')})은 행을 앱의 데이터와 잇는 키입니다 — 지우거나 옮기거나 고치지 마세요.`,
    `숨김 시트(${hiddenSheets.join(' · ')})는 드롭다운 목록과 양식 정보입니다 — 고치지 마세요.`
  );
  return lines.join('\n');
}

function purposeText(projectName: string): string {
  return [
    `「${projectName}」의 성과목표·성과실적·기술목표·측정 이력을 엑셀에서 한꺼번에 적기 위한 양식입니다.`,
    '다 적은 파일을 앱의 목표 화면에서 [양식 올리기]로 올리면 미리보기를 거쳐 반영됩니다.',
    '이 파일은 이 과제 전용입니다 — 다른 과제의 파일, 사업비 입력 양식, 오래된 버전의 양식은 올릴 수 없습니다.',
  ].join('\n');
}

function methodText(): string {
  return [
    `「${sheetName('deliverables')}」: 지표마다 유형·지표명·단위·가중치·전체 목표·연차별 목표·책임기관·평가방법·비고를 적습니다. 지표명과 유형은 반드시 적습니다.`,
    `「${sheetName('achievements')}」: 실적마다 지표명·산출물명·달성일을 반드시 적습니다. 연차·기관·관여자는 비워도 됩니다.`,
    `「${sheetName('techTargets')}」: 평가항목마다 방향·비중·연차별 목표·최종 목표·국내수준·세계최고·측정방법 등을 적습니다. 연차별 목표와 최종 목표 중 하나는 있어야 합니다.`,
    `「${sheetName('records')}」: 측정마다 평가항목·측정값·측정일을 반드시 적습니다.`,
    `연차별 목표 열은 양식을 내려받을 때의 연차 순서 그대로입니다. 열 머리글을 바꿔도 순서로 읽으므로 열을 옮기지 마세요. 빈 칸은 목표 없음, 0은 목표 0입니다.`,
    '유형·방향·측정방법·연차·기관은 드롭다운에서 고릅니다. 목록의 이름과 글자 하나까지 같아야 합니다(비슷한 이름으로 찾지 않습니다).',
    '관여자는 여러 명이면 ;로 이어 적습니다(예: 홍길동;김철수). 이름마다 목록과 완전히 같아야 합니다.',
    `새 행은 각 시트에 미리 깔린 빈 줄(${GOAL_EMPTY_INPUT_ROWS}줄)에 적습니다. 모자라면 합계 행 위에 행을 삽입합니다. 아무것도 적지 않은 빈 줄은 무시됩니다.`,
    '가중치·비중은 %가 아닌 숫자로 적습니다(예: 30% → 30). 목표값에 ≥·이하 같은 표시를 붙이면 방향으로 읽고, 숫자로 풀지 못한 글자는 비고에 [원문]으로 남깁니다.',
  ].join('\n');
}

function principleText(): string {
  return [
    '반영은 행 단위입니다 — 양식에 있던 행은 고쳐지고, 새 행은 추가됩니다. 양식에서 지운 행은 미리보기에서 [삭제 포함]을 켜야만 지워집니다.',
    `성과실적·측정 이력은 지표명·평가항목으로 지표에 이어집니다. 새 행은 같은 파일 「${sheetName('deliverables')}」·「${sheetName('techTargets')}」 시트의 이름과 완전히 같아야 하고, 같은 이름이 둘이면 어느 지표인지 정할 수 없어 반영되지 않습니다.`,
    '이미 있던 실적·측정 행은 숨김 열의 지표 id로 이어집니다 — 지표명을 바꿔도 다른 지표로 옮겨지지 않습니다. 옮기려면 그 행을 지우고 새 행으로 적습니다.',
    '두 지표의 이름을 서로 맞바꾸면 실적 행의 옛 지표명이 다른 지표를 가리켜 막힐 수 있습니다 — 이름을 바꿀 때 실적 시트의 지표명도 함께 고치세요.',
    '지표를 지우면 그 지표의 실적·측정 이력도 함께 지워지고 작업 연계가 끊깁니다. 지운 지표를 가리키는 실적·측정 행이 남아 있으면 반영할 수 없습니다.',
    '양식을 받은 뒤 앱에서 바뀐 행은 충돌로 표시되고 그 행만 건너뜁니다 — 다시 내려받아 고치세요.',
    '오류가 한 건이라도 있으면 반영할 수 없습니다(일부만 반영하지 않습니다). 경고(가중치 합 ≠ 100 등)는 반영을 막지 않습니다.',
  ].join('\n');
}

function cautionText(): string {
  return [
    '목표 양식 반영은 되돌릴 수 없습니다 — 반영 전 미리보기의 추가·변경·삭제 건수를 꼭 확인하세요.',
    '연차 합계 열과 합계 행은 수식이며 읽지 않습니다. 합계 행을 지우거나 그 자리에 값을 적지 마세요.',
    '시트 이름·열 순서를 바꾸거나 열·숨김 시트를 지우면 올릴 수 없습니다. 이 파일은 xlsx로만 저장합니다.',
  ].join('\n');
}

/**
 * F-8 격자: A1 제목, A2 부제, 3행 빈 줄, A4부터 `[라벨, 본문]` 5행.
 * 부제의 `{연차}` 자리는 연차 열 라벨 전부다 — 목표 양식은 연차 하나가 아니라 과제 전체를 담는다.
 * `generatedAt`은 부제에 그대로 — 시각을 여기서 읽지 않아야 같은 입력이면 같은 출력이다.
 */
export function buildGoalGuideSheet(
  projectName: string,
  yearLabels: readonly string[],
  generatedAt: string
): FormSheet {
  const bodies: Record<(typeof GOAL_GUIDE_ROW_LABELS)[number], string> = {
    목적: purposeText(projectName),
    '작성 방법': methodText(),
    원칙: principleText(),
    주의: cautionText(),
    '읽지 않는 열': goalUnreadColumnsText(),
  };
  const years = yearLabels.length > 0 ? yearLabels.join(' · ') : '연차 없음';
  const rows: FormCell[][] = [
    [{ value: `${projectName} — ${GOAL_FORM_TITLE}` }],
    [{ value: `생성 ${generatedAt} · ${years} · 목표` }],
    [],
    ...GOAL_GUIDE_ROW_LABELS.map((label) => [{ value: label }, { value: bodies[label] }]),
  ];
  return { name: goalSheetsFor(0).guide.name, hidden: false, rows, hiddenColumns: [], kind: 'guide' };
}
