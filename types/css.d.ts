// tsc(--noEmit)는 Next 빌드와 달리 CSS side-effect import를 해석하지 못한다 (TS2882 방지)
declare module '*.css';
