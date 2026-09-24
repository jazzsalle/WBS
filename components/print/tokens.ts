// 인쇄 표 스타일 토큰 (SOT §12 P-R2)
// 인쇄 대상 3종(기술목표표·리스크 대장·예산 매트릭스)이 같은 표 모양으로 나와야 해서 한곳에 둔다.
// 전부 print: 접두라 @media print에서만 켜지고 화면 렌더에는 영향이 없다.

/** 표를 감싼 스크롤 상자. 인쇄에서는 가로 스크롤·둥근 테두리가 의미 없다 */
export const PRINT_TABLE_WRAP = 'print:overflow-visible print:rounded-none print:border-0';

/** 표 본체. 화면용 min-width를 풀어 A4 폭에 맞추고 괘선을 합친다 */
export const PRINT_TABLE = 'print:min-w-0 print:border-collapse print:text-xs';

/** 머리셀 괘선 — 본문보다 진하게 */
export const PRINT_TH = 'print:border print:border-grey-500';

/** 본문셀 괘선 */
export const PRINT_TD = 'print:border print:border-grey-400';
