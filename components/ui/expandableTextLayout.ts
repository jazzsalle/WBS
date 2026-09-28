// 긴 텍스트 한 줄 표시의 순수 로직 (Phase 22 U-12)
//
// 목표 화면의 서술형 칸(평가방법·평가환경·표준·비고 등)은 계획서에서 붙여 넣은 여러 줄이라
// 그대로 펼치면 표 한 행이 화면 하나를 차지한다. 접힌 상태에서 무엇을 보일지만 여기서 정한다 —
// "한 줄 폭을 넘는가"는 글꼴·칸 폭에 달려 있어 컴포넌트가 실제 렌더 폭으로 따로 판정한다.

export interface FirstLine {
  /** 접힌 상태에서 보일 첫 줄 (앞뒤 공백 제거) */
  first: string;
  /** 첫 줄 뒤에 내용이 더 있는지 — 개행 때문에 폭과 상관없이 [더보기]가 필요하다 */
  hasMore: boolean;
}

export function splitFirstLine(text: string): FirstLine {
  // 앞쪽 빈 줄이 첫 줄이 되면 접힌 칸이 비어 보인다 — 내용 있는 첫 줄부터 센다
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() !== '');
  if (start === -1) return { first: '', hasMore: false };
  const rest = lines.slice(start + 1).some((line) => line.trim() !== '');
  return { first: (lines[start] ?? '').trim(), hasMore: rest };
}

export interface OverlayPlacement {
  left: number;
  width: number;
  maxHeight: number;
  /** 둘 중 하나만 값이 있다 — 아래로 펼칠지 위로 펼칠지 */
  top: number | null;
  bottom: number | null;
}

export interface Rect {
  left: number;
  top: number;
  bottom: number;
}

const MARGIN = 8;
const GAP = 4;
const MAX_WIDTH = 448;
const MAX_HEIGHT = 320;
/** 아래 공간이 이보다 좁고 위가 더 넓으면 위로 띄운다 */
const MIN_BELOW = 160;

/** 오버레이를 화면 안에 두는 좌표. 앵커 바로 아래가 기본, 아래가 좁으면 위로 뒤집는다 */
export function placeOverlay(anchor: Rect, viewportWidth: number, viewportHeight: number): OverlayPlacement {
  const width = Math.max(0, Math.min(MAX_WIDTH, viewportWidth - MARGIN * 2));
  const left = Math.min(Math.max(anchor.left, MARGIN), Math.max(MARGIN, viewportWidth - width - MARGIN));
  const below = viewportHeight - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  if (below >= MIN_BELOW || below >= above) {
    return { left, width, maxHeight: Math.max(0, Math.min(MAX_HEIGHT, below)), top: anchor.bottom + GAP, bottom: null };
  }
  return {
    left,
    width,
    maxHeight: Math.max(0, Math.min(MAX_HEIGHT, above)),
    top: null,
    bottom: viewportHeight - anchor.top + GAP,
  };
}
