// 작성안내 시트 (SOT §7.9.7 "서식(Phase 19)", 부록 F-8).
//
// 워크북의 첫 시트다. 파서는 읽지 않는다 — 사용자에게 "무엇을 어디에 적고, 무엇이 반영되지 않는가"를
// 파일 안에서 말해 주는 것이 전부다. 문장은 §6.16·§7.9.7 규칙을 사용자 말로 풀어 쓴 것이므로
// 규칙이 바뀌면 여기도 함께 바꾼다. 서식(글꼴·채움·너비)은 어댑터가 `kind: 'guide'`를 보고 F-8로 입힌다.
//
// '읽지 않는 열'은 좌표 맵에서 **생성**한다 — 하드코딩하면 열이 늘거나 읽기 여부가 바뀔 때
// 안내가 거짓이 된다(IN-1).

import { INPUT_FORM_SHEETS } from './layout';
import type { InputFormSheetDef } from './layout';
import type { FormCell, FormSheet, InputFormData } from './types';

export const GUIDE_SHEET_NAME = '작성안내';

/** F-8 부제 `{모드}` 자리. 입력 양식은 제안 모드 전용이다 */
export const INPUT_FORM_MODE_LABEL = '제안';

/** A1 제목의 `{양식 이름}` 자리(F-8) */
export const INPUT_FORM_TITLE = '사업비 입력 양식';

/** 작성안내 표의 행 라벨. 순서가 F-8이다 */
export const GUIDE_ROW_LABELS = ['목적', '작성 방법', '원칙', '주의', '읽지 않는 열'] as const;

function joinLabels(columns: readonly InputFormSheetDef['columns'][number][]): string {
  return columns.map((c) => c.label).join(' · ');
}

/** 보이는데 읽지 않는 열(부록 F-3 키 열)을 시트별로 나열한다. 숨김 키 열은 따로 한 줄 */
export function unreadColumnsText(): string {
  const lines: string[] = [];
  const hiddenLabels: string[] = [];
  for (const def of Object.values(INPUT_FORM_SHEETS)) {
    if (def.hidden) continue;
    const unread = def.columns.filter((c) => !c.hidden && !c.read);
    if (unread.length > 0) lines.push(`「${def.name}」 ${joinLabels(unread)}`);
    for (const c of def.columns) if (c.hidden) hiddenLabels.push(c.label);
  }
  lines.push(
    '위 열은 연한 베이지 바탕이며 값을 고쳐도 반영되지 않습니다(앱의 값이 원본입니다).',
    `숨김 열(${[...new Set(hiddenLabels)].join(' · ')})은 행을 앱의 데이터와 잇는 키입니다 — 지우거나 옮기지 마세요.`
  );
  return lines.join('\n');
}

function purposeText(data: InputFormData): string {
  return [
    `「${data.project.name}」 ${data.year.name}의 사업비 산출근거(예산 계획)를 엑셀에서 한꺼번에 적기 위한 양식입니다.`,
    '다 적은 파일을 앱의 연구비 화면에서 [입력 양식 올리기]로 올리면 미리보기를 거쳐 반영됩니다.',
    '이 파일은 이 과제·이 연차 전용입니다 — 다른 과제의 파일이나 오래된 버전의 양식은 올릴 수 없습니다.',
  ].join('\n');
}

function methodText(): string {
  return [
    '「인건비」 시트: 인력마다 세목·참여율(%)·참여개월·현금/현물·조정액을 적습니다. 참여율은 0~100, 참여개월은 0~12입니다(연차 개월을 넘으면 경고).',
    '한 사람이 두 구간으로 참여하면 그 사람의 행을 복사해 한 줄 더 적습니다.',
    '「사업비」 시트: 세목마다 미리 깔린 빈 줄에 품명·규격·단가·인자1~3·조정액·현금/현물·비고를 적습니다. 줄이 모자라면 같은 세목 안에서 행을 복사해 넣습니다.',
    '단가·조정액은 원 단위 정수, 인자는 소수도 됩니다. 금액 = 단가 × 인자(비어 있으면 1) + 조정액입니다.',
    '아무것도 적지 않은 빈 줄은 무시됩니다.',
  ].join('\n');
}

function principleText(): string {
  return [
    '인력은 이 양식에 실린 인력만 받습니다 — 이름으로 찾지 않습니다. 새 인력은 앱에서 먼저 만든 뒤 양식을 다시 내려받습니다.',
    '반영은 양식에 행이 있는 비목 단위로 기존 산출근거를 바꿉니다. 행이 하나도 없는 비목의 기존 산출근거는 지우지 않고 그대로 둡니다.',
    '반영 전 미리보기에서 추가·변경·삭제·유지 건수와 합계, 연구비 사용 규칙 검사 결과를 확인합니다. 반영 전 상태는 스냅샷으로 남아 되돌릴 수 있습니다.',
    '경고(연차 개월 초과·규칙 위반 등)는 반영을 막지 않습니다 — 내용을 확인하고 진행하세요.',
  ].join('\n');
}

function cautionText(): string {
  return [
    '금액 열은 읽지 않는다 — 올리면 서버가 다시 계산한다. 엑셀 수식은 같은 값을 미리 보여 주기 위한 것이라 금액 칸에 값을 직접 적어도 반영되지 않습니다.',
    '참여율·인자 칸에는 %가 아닌 숫자를 적습니다(예: 30% → 30). 백분율 서식을 걸지 마세요.',
    '소계·총액 행은 수식이며 읽지 않습니다. 행을 지우거나 그 자리에 값을 적지 마세요.',
    '시트 이름·열 순서를 바꾸거나 열을 지우면 올릴 수 없습니다. 이 파일은 xlsx로만 저장합니다.',
  ].join('\n');
}

/**
 * F-8 격자: A1 제목, A2 부제, 3행 빈 줄, A4부터 `[라벨, 본문]` 5행.
 * `todayISO`는 부제에 그대로 — 시각을 여기서 읽지 않아야 같은 입력이면 같은 출력이다.
 */
export function buildGuideSheet(data: InputFormData, todayISO: string): FormSheet {
  const bodies: Record<(typeof GUIDE_ROW_LABELS)[number], string> = {
    목적: purposeText(data),
    '작성 방법': methodText(),
    원칙: principleText(),
    주의: cautionText(),
    '읽지 않는 열': unreadColumnsText(),
  };
  const rows: FormCell[][] = [
    [{ value: `${data.project.name} — ${INPUT_FORM_TITLE}` }],
    [{ value: `생성 ${todayISO} · ${data.year.name} · ${INPUT_FORM_MODE_LABEL}` }],
    [],
    ...GUIDE_ROW_LABELS.map((label) => [{ value: label }, { value: bodies[label] }]),
  ];
  return { name: GUIDE_SHEET_NAME, hidden: false, rows, hiddenColumns: [], kind: 'guide' };
}
