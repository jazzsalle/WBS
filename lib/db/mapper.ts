// DB snake_case ↔ 앱 camelCase 변환 (SOT §5.1, §8.6)
// 이 파일만 변환을 전담한다. 리포지토리 밖에서 케이스 변환을 하지 않는다.
//
// 특례 2가지:
//  - N-9: DB `sort_order` ↔ 앱 `order` (order는 SQL 예약어)
//  - jsonb 컬럼의 내부 키는 변환하지 않는다. targetByYear의 키는 yearId(uuid 문자열),
//    categoryAliases의 키는 엑셀 원문 라벨이다 — 키를 건드리면 데이터가 깨진다 (N-3, N-13).

// N-3의 jsonb 컬럼 목록 (snake·camel 양방향). 값을 통째로 그대로 통과시킨다 —
// jsonb 내부는 항상 "앱 형태 그대로" 저장된다 (yearColumnMappings의 yearOrder 등).
const JSONB_PASSTHROUGH_KEYS = new Set([
  'tags',
  'target_by_year', 'targetByYear',
  'category_aliases', 'categoryAliases',
  'label_columns', 'labelColumns',
  'year_column_mappings', 'yearColumnMappings',
  'skip_row_patterns', 'skipRowPatterns',
  'snapshot', // import_snapshots.snapshot — commit_import RPC가 기록한 원본 그대로 (I-17)
]);

function snakeToCamelKey(key: string): string {
  if (key === 'sort_order') return 'order'; // N-9
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnakeKey(key: string): string {
  if (key === 'order') return 'sort_order'; // N-9
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertValue(value: unknown, convertKey: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => convertValue(v, convertKey));
  }
  if (isPlainObject(value)) {
    return convertObject(value, convertKey);
  }
  return value;
}

function convertObject(
  obj: Record<string, unknown>,
  convertKey: (key: string) => string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (JSONB_PASSTHROUGH_KEYS.has(key)) {
      out[convertKey(key)] = value; // 키만 변환, 내부는 원본 그대로
    } else {
      out[convertKey(key)] = convertValue(value, convertKey);
    }
  }
  return out;
}

// DB row(snake_case) → 앱 객체(camelCase). 중첩 select 결과(임베드 배열)도 재귀 변환한다.
// 반환 타입은 호출한 리포지토리가 책임진다 — 반드시 schema.ts로 검증한 row를 넘길 것 (§8.6).
export function dbToApp<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  return convertObject(row, snakeToCamelKey) as T;
}

// 앱 객체(camelCase) → DB row(snake_case). insert/update payload에 쓴다.
export function appToDb(value: Record<string, unknown>): Record<string, unknown> {
  return convertObject(value, camelToSnakeKey);
}

export function dbToAppArray<T = Record<string, unknown>>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => dbToApp<T>(row));
}
