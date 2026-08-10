// 테스트 잔여 행 표식 — helpers.destroyTestUser가 찍고 global-setup이 읽는다. 한 곳에서만 정의한다:
// 이 문자열은 "지워도 되는 행"을 판정하는 근거라, 두 곳으로 갈라지면 그 순간 오판이 곧 데이터 파괴다.
//
// 왜 필요한가: 루트 테이블의 created_by는 on delete set null(N-8)이다. 테스트가 afterAll에서
// auth.users를 지우는 순간 그 사용자가 만든 과제·todo·노트·프로파일은 소유자를 잃고,
// 소유자 기반 자동 청소(global-setup)가 영영 되찾지 못하는 고아가 된다.
// 실제로 2026-08-09에 치운 잔여 행 213개 중 197개가 이 경우였다.
//
// 표식을 "만들 때"가 아니라 "소유자를 끊기 직전"에 찍는 이유 — 오판 위험을 0에 가깝게 만든다:
//  - 찍는 시점에 그 행의 created_by는 wbs-test+…@unes.co.kr 사용자임이 SQL로 증명된 상태다.
//    즉 실데이터에는 이 표식이 붙을 경로가 아예 없다. 과제명 접두사처럼 "사람이 같은 이름을
//    쓸 수도 있는" 표식과 달리, 사용자가 이 문자열을 손으로 넣지 않는 한 충돌이 불가능하다.
//  - 테스트 작성자가 표식 넣기를 잊을 수 없다. 모든 통합 테스트가 destroyTestUser를 거친다.
// 그래도 남는 위험(사용자가 이 UUID를 그대로 타이핑)은 global-setup이 표식 + 소유자 끊김 +
// 2시간 경과를 모두 만족할 때만 지우게 해서 한 번 더 좁힌다.

/**
 * 잔여 행의 라벨 컬럼(projects.project_no, todos/notes.title, import_profiles.name) 앞에 붙는다.
 * 고정 UUID를 넣어 사람이 우연히 입력할 가능성을 없앤다. 값을 바꾸면 이전 잔여물을 못 찾는다.
 */
export const TEST_ROW_MARK = 'wbs-test-orphan:9f2a7d64-3c15-4b8e-a0d7-5e61c8b3f402 ';

/** SQL like 패턴 — 접두사 일치. TEST_ROW_MARK에는 like 메타문자(%, _)가 없다 */
export const TEST_ROW_MARK_PATTERN = `${TEST_ROW_MARK}%`;
