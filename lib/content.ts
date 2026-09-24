// 도움말·따라하기 본문 로더 (SOT §7.16 HP-1·HP-2·HP-6, §7.17 TU-7)
//
// content/**.md를 fs로 읽어 lib/notes.ts AST로 바꾼다 — 렌더 경로는 노트와 같다(HP-2).
// HTML 문자열은 어디에서도 만들지 않는다. 서버 전용: fs는 브라우저에 없고, 이 모듈이
// 클라이언트 번들에 섞이면 빌드 시점에 막힌다(`server-only`).
//
// 없는 파일·형식 위반은 **throw**한다. 빈 문서로 대체하면 standalone 산출물에서 content/가
// 빠진 배포 사고(HP-1)가 "도움말이 좀 비어 있네"로 보이고 만다(절대 규칙 5).

import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MdBlock } from '@/lib/notes';
import { parseMarkdown } from '@/lib/notes';
import type { HelpSlug, TutorialStepSlug } from '@/lib/help';
import {
  TUTORIAL_STEP_SLUGS,
  isHelpSlug,
  isTutorialStepSlug,
  parseHelpHead,
  parseTutorialHead,
} from '@/lib/help';

// process.cwd() 기준 — standalone 사이드카도 프로젝트 루트에서 기동한다(lib/export-adapter.ts의
// TEMPLATES_DIR와 같은 전제). outputFileTracingIncludes에 ./content/**가 있어야 여기 파일이 남는다
export const CONTENT_ROOT = path.join(process.cwd(), 'content');

export interface HelpDocument {
  slug: HelpSlug;
  title: string;
  intro: string;
  blocks: MdBlock[];
}

export interface TutorialDocument {
  step: TutorialStepSlug;
  title: string;
  intro: string;
  blocks: MdBlock[];
}

async function readContentFile(relative: string): Promise<string> {
  const file = path.join(CONTENT_ROOT, relative);
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `본문 파일을 읽지 못했습니다: content/${relative} — ${reason}. ` +
        'standalone 빌드라면 next.config.ts outputFileTracingIncludes에 ./content/**가 있는지 확인하세요 (HP-1).'
    );
  }
}

export async function readHelpDocument(slug: HelpSlug): Promise<HelpDocument> {
  if (!isHelpSlug(slug)) {
    throw new Error(`알 수 없는 도움말 slug: ${String(slug)}`);
  }
  const source = await readContentFile(`help/${slug}.md`);
  const head = parseHelpHead(source);
  if ('error' in head) {
    throw new Error(`content/help/${slug}.md 형식 위반(HP-6): ${head.error}`);
  }
  return { slug, title: head.title, intro: head.intro, blocks: parseMarkdown(source) };
}

export async function readTutorialDocument(step: TutorialStepSlug): Promise<TutorialDocument> {
  if (!isTutorialStepSlug(step)) {
    throw new Error(`알 수 없는 따라하기 단계: ${String(step)}`);
  }
  const source = await readContentFile(`tutorial/${step}.md`);
  const head = parseTutorialHead(source);
  if ('error' in head) {
    throw new Error(`content/tutorial/${step}.md 형식 위반(TU-7): ${head.error}`);
  }
  return { step, title: head.title, intro: head.intro, blocks: parseMarkdown(source) };
}

/** 9단계 전부, TU-2 순서. 하나라도 없으면 통째로 실패한다 — 단계가 조용히 빠진 드로어를 만들지 않는다 */
export async function readAllTutorialDocuments(): Promise<TutorialDocument[]> {
  return Promise.all(TUTORIAL_STEP_SLUGS.map((step) => readTutorialDocument(step)));
}
