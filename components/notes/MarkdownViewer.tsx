// 마크다운 뷰어 (SOT §7.12 "마크다운 textarea + 프리뷰 토글")
//
// **HTML 문자열을 만들지 않는다.** lib/notes.ts가 원문을 AST로 바꾸고, 여기서는 그 AST를
// React 엘리먼트로만 옮긴다. dangerouslySetInnerHTML을 쓰지 않으므로 본문에 <script>나
// on* 속성이 들어와도 React가 글자로 이스케이프해 그린다 — 주입 경로 자체가 없다.
// 링크는 lib/notes.isSafeUrl을 통과한 http/https/mailto만 <a>가 된다(javascript: 차단).
// 이 성질은 tests/unit/notes.test.ts가 AST 수준에서 고정한다.

import type { MdBlock, MdInline, MdListItem } from '@/lib/notes';
import { parseMarkdown } from '@/lib/notes';

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-5 mb-2 text-xl font-bold text-grey-900',
  2: 'mt-5 mb-2 text-lg font-bold text-grey-900',
  3: 'mt-4 mb-1.5 text-base font-bold text-grey-800',
  4: 'mt-3 mb-1 text-sm font-bold text-grey-800',
  5: 'mt-3 mb-1 text-sm font-semibold text-grey-700',
  6: 'mt-3 mb-1 text-xs font-semibold text-grey-600',
};

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'text':
            return <span key={index}>{node.text}</span>;
          case 'code':
            return (
              <code key={index} className="rounded bg-grey-100 px-1 py-0.5 font-mono text-[0.85em] text-grey-800">
                {node.text}
              </code>
            );
          case 'strong':
            return (
              <strong key={index} className="font-bold">
                <Inline nodes={node.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={index} className="italic">
                <Inline nodes={node.children} />
              </em>
            );
          case 'link':
            return (
              <a
                key={index}
                href={node.href}
                target="_blank"
                // opener 탈취 방지. 데스크톱 셸에서도 외부 링크는 새 컨텍스트로 연다
                rel="noreferrer noopener"
                className="text-blue-700 underline underline-offset-2 hover:text-blue-900"
              >
                <Inline nodes={node.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function ListItem({ item }: { item: MdListItem }) {
  return (
    <li
      className={item.checked === null ? 'list-disc' : 'list-none'}
      style={{ marginLeft: `${item.depth * 1.25}rem` }}
    >
      {item.checked !== null && (
        <input
          type="checkbox"
          checked={item.checked}
          readOnly
          // 본문(마크다운 원문)이 진실이다 — 미리보기에서 체크를 바꿔 저장하지 않는다 (§5.14)
          aria-label={item.checked ? '완료된 항목' : '미완료 항목'}
          className="mr-1.5 h-3.5 w-3.5 translate-y-[1px] rounded border-grey-300"
        />
      )}
      <Inline nodes={item.children} />
    </li>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1';
      return (
        <Tag className={HEADING_CLASS[block.level] ?? HEADING_CLASS[6]}>
          <Inline nodes={block.children} />
        </Tag>
      );
    }
    case 'paragraph':
      // 문단 안의 줄바꿈은 원문 그대로 보존한다 (회의록은 줄 단위로 읽힌다)
      return (
        <p className="my-2 whitespace-pre-wrap break-words text-sm leading-6 text-grey-700">
          <Inline nodes={block.children} />
        </p>
      );
    case 'codeBlock':
      return (
        <pre className="my-3 overflow-x-auto rounded-lg bg-grey-900 p-3 text-xs leading-5 text-grey-100">
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote className="my-3 border-l-4 border-grey-300 pl-3 text-sm text-grey-600">
          {block.lines.map((line, index) => (
            <p key={index} className="my-0.5">
              <Inline nodes={line} />
            </p>
          ))}
        </blockquote>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          className={`my-2 space-y-1 pl-5 text-sm leading-6 text-grey-700 ${
            block.ordered ? 'list-decimal' : ''
          }`}
        >
          {block.items.map((item, index) => (
            <ListItem key={index} item={item} />
          ))}
        </Tag>
      );
    }
    case 'hr':
      return <hr className="my-4 border-grey-200" />;
  }
}

export interface MarkdownViewerProps {
  /** 마크다운 원문 (Note.body) */
  source: string;
  className?: string;
}

export default function MarkdownViewer({ source, className = '' }: MarkdownViewerProps) {
  const blocks = parseMarkdown(source);

  if (blocks.length === 0) {
    return (
      <div className={className}>
        <p className="text-sm text-grey-400">본문이 비어 있습니다. 왼쪽 편집기에 마크다운으로 적으세요.</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
