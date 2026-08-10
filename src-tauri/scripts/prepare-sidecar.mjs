#!/usr/bin/env node
// Next standalone 산출물 + Node 런타임을 Tauri 리소스로 복사한다.
// tauri.conf.json beforeBuildCommand에서 `npm run build` 직후 실행된다 (SOT §14.1).
//
// 사이드카 실행 방식: Next standalone은 Node 런타임이 필요하다. 최종 사용자 PC에
// Node 설치를 요구하지 않기 위해, 빌드 머신의 node 실행 파일(process.execPath)을
// resources/node/에 동봉하고 src/sidecar.rs가 `node server.js`로 띄운다.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tauriDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(tauriDir, '..');

const standaloneDir = join(rootDir, '.next', 'standalone');
const staticDir = join(rootDir, '.next', 'static');
const publicDir = join(rootDir, 'public');
const resourcesDir = join(tauriDir, 'resources');
const webDir = join(resourcesDir, 'web');
const nodeDir = join(resourcesDir, 'node');

if (!existsSync(join(standaloneDir, 'server.js'))) {
  console.error(
    '[prepare-sidecar] .next/standalone/server.js가 없습니다 — `npm run build`를 먼저 실행하세요.',
  );
  process.exit(1);
}

// 안전장치: `next dev` 잔여물이 섞인 .next를 그대로 번들에 싣지 않는다.
// clean-next.mjs(prebuild)가 막아 주지만, `next build`를 직접 부르면 그 단계를 건너뛴다.
// 조용히 걸러내지 않고 멈추는 이유: 잔여물이 있는 .next는 standalone 복사·프리렌더가
// 산발적으로 깨져 산출물 자체를 믿을 수 없다 (절대 규칙 5).
const devLeftovers = ['development', 'webpack'].filter((d) => existsSync(join(staticDir, d)));
if (devLeftovers.length > 0) {
  console.error(
    `[prepare-sidecar] .next/static에 dev 잔여물이 있습니다 (${devLeftovers.join(', ')}) — 빌드 중단.\n` +
      '  `npm run build`로 다시 빌드하세요 (prebuild가 .next를 정리합니다).',
  );
  process.exit(1);
}

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(nodeDir, { recursive: true });

cpSync(standaloneDir, webDir, { recursive: true });
// standalone은 정적 자산을 포함하지 않으므로 별도로 복사한다 (Next 공식 배포 절차)
cpSync(staticDir, join(webDir, '.next', 'static'), { recursive: true });
if (existsSync(publicDir)) {
  cpSync(publicDir, join(webDir, 'public'), { recursive: true });
}

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
copyFileSync(process.execPath, join(nodeDir, nodeName));

// 안전장치: standalone이 복사한 .env* 파일에 service_role 키가 실려 나가는 사고 차단
// (SOT §8.2 C-1 — 데스크톱 앱은 사용자 손에 있는 코드다)
const offenders = [];
scanEnvFiles(webDir);
if (offenders.length > 0) {
  console.error(
    `[prepare-sidecar] service_role 키가 산출물에 포함됨 — 빌드 중단:\n  ${offenders.join('\n  ')}`,
  );
  process.exit(1);
}

console.log('[prepare-sidecar] 완료:');
console.log(`  web  ← ${standaloneDir}`);
console.log(`  node ← ${process.execPath} (${process.version})`);

function scanEnvFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules는 .env를 담지 않고 순회 비용만 크다
      if (entry.name !== 'node_modules') scanEnvFiles(full);
    } else if (entry.name.startsWith('.env')) {
      if (/service_role/i.test(readFileSync(full, 'utf8'))) offenders.push(full);
    }
  }
}
