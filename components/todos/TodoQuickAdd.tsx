'use client';

// 한 줄 빠른 추가 (SOT §7.13 "상단에 한 줄 빠른 추가(제목만 입력 → Enter)")
// 마감일·우선순위·과제는 여기서 받지 않는다 — 추가한 뒤 행에서 붙인다. 입력 항목이 늘면
// "한 줄"이 아니게 되고, 할 일을 적어 두는 속도가 떨어진다.
// 저장은 actions/todos.ts의 createTodo만 거친다 (§8.2 C-2).

import { useEffect, useRef, useState } from 'react';
import { createTodo } from '@/actions/todos';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Button from '@/components/ui/Button';
import type { Failure } from './TodoScreen';

export interface TodoQuickAddProps {
  busy: boolean;
  onFailure: (failure: Failure | null) => void;
  onCreated: () => void;
}

export default function TodoQuickAdd({ busy, onFailure, onCreated }: TodoQuickAddProps) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // R-4: 적다 만 제목이 남의 변경에 의한 자동 새로고침으로 날아가면 안 된다.
  // 포커스가 아니라 "친 글자가 있는 동안"만 보류한다 — 빈 입력창을 열어 둔 사람에게
  // 남의 변경이 영영 반영되지 않는 일을 막는다.
  const dirty = title !== '';
  useEffect(() => {
    if (!dirty) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dirty]);

  const submit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed === '') {
      // 서버도 다시 검증한다(§9). 여기서 막는 이유는 왕복 없이 즉시 알려주기 위해서다.
      onFailure({ message: '할 일을 입력하세요.', code: 'VALIDATION' });
      return;
    }

    setSaving(true);
    onFailure(null);
    // 제목만 보낸다. priority는 §5.15 DB 기본값('normal')을 액션이 적용한다.
    const res = await createTodo({ title: trimmed });
    setSaving(false);

    if (!res.ok) {
      // 실패하면 입력을 지우지 않는다 — 다시 칠 필요가 없게 (절대 규칙 5)
      onFailure({ message: res.error, code: res.code });
      return;
    }
    setTitle('');
    inputRef.current?.focus(); // 연속으로 적을 수 있게 커서를 남긴다
    onCreated();
  };

  const disabled = busy || saving;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault(); // Enter는 폼 submit으로 들어온다
        if (!disabled) void submit();
      }}
      className="flex items-center gap-2 rounded-xl border border-grey-200 bg-surface p-3"
    >
      <span aria-hidden className="pl-1 text-lg leading-none text-grey-300">
        +
      </span>
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={disabled}
        maxLength={200}
        aria-label="할 일 빠른 추가"
        placeholder="할 일을 적고 Enter — 마감일·우선순위·과제는 아래 행에서 붙입니다"
        className="min-w-0 flex-1 border-0 bg-transparent px-1 py-1.5 text-sm focus:outline-none disabled:opacity-50"
      />
      <Button type="submit" size="sm" variant="primary" disabled={disabled || title.trim() === ''}>
        {saving ? '추가 중…' : '추가'}
      </Button>
    </form>
  );
}
