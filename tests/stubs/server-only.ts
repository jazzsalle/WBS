// `import 'server-only'` (I-13)의 vitest 대체 모듈.
//
// 실제 'server-only' 패키지는 import되는 즉시 예외를 던져 클라이언트 번들 유입을 막는다.
// 그 가드는 Next 빌드에서만 의미가 있고, 단위 테스트는 어댑터를 노드에서 직접 돌려야 하므로
// vitest.shared.ts가 이 빈 모듈로 별칭을 건다. 프로덕션 번들과는 무관하다.
export {};
