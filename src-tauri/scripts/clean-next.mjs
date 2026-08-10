#!/usr/bin/env node
// 프로덕션 빌드 전에 .next를 비운다. package.json의 `prebuild`로 `npm run build` 직전에 돈다
// (tauri.conf.json의 beforeBuildCommand도 `npm run build`를 부르므로 데스크톱 빌드에도 그대로 걸린다).
//
// 왜 필요한가: `next dev`와 `next build`가 같은 .next를 쓴다. dev가 남긴 비해시 청크
// (`static/chunks/app/layout.js` 3.67MB)와 `static/development/`·`static/webpack/`는
// build가 지우지 않아 그대로 남고, prepare-sidecar.mjs가 `.next/static`을 통째로 복사하면
// 설치 파일에 죽은 파일로 실려 나간다. 더 나쁜 건 빌드 자체다 — 잔여물이 있으면
// standalone 복사 단계에서 ENOENT나 프리렌더 실패가 산발적으로 난다.
//
// dev 산출물만 골라 거르지 않고 통째로 지우는 이유: dev 청크는 프로덕션 청크와 같은
// 디렉터리에 섞여 있고 이름만 비해시라, 매니페스트를 역참조하지 않으면 정확히 가려낼 수
// 없다. 그리고 걸러내기는 빌드 실패 쪽을 전혀 못 고친다.
//
// cache만 남긴다: Next 공식 CI 권장대로 `.next/cache`는 증분 컴파일 캐시일 뿐
// 산출물이 아니라 사이드카로 복사되지 않고, 이걸 지우면 빌드 시간만 늘어난다.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const nextDir = join(rootDir, '.next');

/** 증분 빌드 캐시 — 산출물이 아니므로 보존한다 */
const KEEP = new Set(['cache']);

if (!existsSync(nextDir)) {
  console.log('[clean-next] .next 없음 — 건너뜁니다.');
  process.exit(0);
}

const removed = [];
for (const entry of readdirSync(nextDir)) {
  if (KEEP.has(entry)) continue;
  rmSync(join(nextDir, entry), { recursive: true, force: true });
  removed.push(entry);
}

console.log(
  removed.length === 0
    ? '[clean-next] 지울 산출물이 없습니다.'
    : `[clean-next] .next 산출물 ${removed.length}개 제거 (cache 보존): ${removed.join(', ')}`,
);
