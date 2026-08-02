'use client';

// 실시간 반영 (SOT §8.5 R-1~R-7, §8.2 C-2 예외)
// C-2의 유일한 예외: Realtime 구독만 클라이언트에서 직접 한다(읽기 전용). 쓰기는 전부 서버 액션이다.
//  R-1 화면이 쓰는 테이블만 구독한다 — 전체 구독 금지 (무료 플랜 200 동시 연결)
//  R-2 이벤트를 받으면 데이터를 직접 패치하지 않고 router.refresh()로 서버 컴포넌트를 다시 가져온다
//  R-3 500ms 디바운스
//  R-4 편집 중인 폼이 열려 있으면 보류하고 "새 변경 있음 · 새로고침" 배너만 띄운다
//  R-5 연결이 끊기면 30초 폴링으로 폴백
//  R-6 이벤트의 updated_by가 나면 무시 (self-echo)
//  R-7 구독 대상 테이블은 마이그레이션의 publication에 등록되어 있어야 이벤트가 온다
//      (20260802000000_initial_schema.sql §34)

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getBrowserClient } from '@/lib/db/client';

const DEBOUNCE_MS = 500; // R-3
const POLL_MS = 30_000; // R-5

// ─── R-4 편집 중 보류 스위치 ────────────────────────────────
// 폼 모달은 화면 트리의 어디에나 있을 수 있고 Refresher는 페이지 최상단에 마운트되므로
// props로 잇지 않고 모듈 수준 스위치로 잇는다. 폼이 열릴 때 true, 닫힐 때 false.
let editingCount = 0;
const pauseListeners = new Set<() => void>();

function notifyPauseListeners(): void {
  for (const listener of pauseListeners) listener();
}

/** 폼이 열려 있는 동안 자동 새로고침을 보류한다 (R-4). 중첩 호출을 세므로 반드시 짝을 맞춘다. */
export function setRealtimePaused(paused: boolean): void {
  editingCount = Math.max(0, editingCount + (paused ? 1 : -1));
  notifyPauseListeners();
}

function subscribePaused(onChange: () => void): () => void {
  pauseListeners.add(onChange);
  return () => {
    pauseListeners.delete(onChange);
  };
}

export interface RealtimeRefresherProps {
  /** R-1 §8.5 구독표의 화면별 테이블 목록 */
  tables: string[];
  /** R-6 self-echo 필터용 — 내 app_users.id */
  selfUserId: string;
}

export default function RealtimeRefresher({ tables, selfUserId }: RealtimeRefresherProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const isPaused = useSyncExternalStore(
    subscribePaused,
    () => editingCount > 0,
    () => false // 서버 렌더에서는 편집 중일 수 없다
  );
  const [pendingChange, setPendingChange] = useState(false); // R-4 배너
  const [disconnected, setDisconnected] = useState(false); // R-5 폴백 중 표시

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pausedRef = useRef(isPaused);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  // R-2: 계산 로직을 클라이언트에 복제하지 않기 위해 서버 컴포넌트를 다시 가져온다
  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  const requestRefresh = useCallback(() => {
    // R-4: 편집 중이면 새로고침하지 않고 배너만 띄운다 (입력 중인 내용을 지우지 않는다)
    if (pausedRef.current) {
      setPendingChange(true);
      return;
    }
    refresh();
  }, [refresh]);

  // R-3: 이벤트 폭주(임포트·일괄 갱신)에 화면이 계속 다시 그려지지 않게 한 번으로 묶는다
  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      requestRefresh();
    }, DEBOUNCE_MS);
  }, [requestRefresh]);

  // 배열 prop은 렌더마다 새 참조라서 그대로 의존성에 두면 매번 재구독한다
  const tablesKey = tables.join(',');

  useEffect(() => {
    const tableList = tablesKey.split(',').filter(Boolean);
    if (tableList.length === 0) return;

    const startPolling = () => {
      if (pollRef.current) return;
      setDisconnected(true);
      pollRef.current = setInterval(requestRefresh, POLL_MS);
    };
    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setDisconnected(false);
    };

    const client = getBrowserClient();
    // 화면(테이블 집합)마다 채널 하나 — R-1의 "화면에 관련된 테이블만"
    const channel: RealtimeChannel = client.channel(`refresh:${tablesKey}`);

    for (const table of tableList) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => {
          // 행은 DB 원본(snake_case)으로 온다. DELETE는 updated_by를 알 수 없어 항상 새로고침한다.
          const row = (payload.new ?? payload.old) as { updated_by?: string | null } | null;
          if (row && row.updated_by === selfUserId) return; // R-6
          scheduleRefresh();
        }
      );
    }

    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        stopPolling();
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // 에러를 삼키지 않는다 — 폴백으로 넘어간 사실을 로그와 화면 표시로 남긴다 (R-5)
        if (err) console.warn('[RealtimeRefresher] 구독 오류, 폴링으로 전환합니다:', err.message);
        startPolling();
      }
    });

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      stopPolling();
      void client.removeChannel(channel);
    };
  }, [tablesKey, selfUserId, scheduleRefresh, requestRefresh]);

  // 폼이 닫히면 보류해 둔 변경을 그때 반영한다 (더 이상 지울 입력이 없다)
  useEffect(() => {
    if (!isPaused && pendingChange) {
      setPendingChange(false);
      refresh();
    }
  }, [isPaused, pendingChange, refresh]);

  if (!pendingChange && !disconnected) return null;

  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col gap-2">
      {pendingChange && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 shadow-lg"
        >
          <span>새 변경 있음</span>
          <button
            type="button"
            onClick={() => {
              setPendingChange(false);
              refresh();
            }}
            className="font-semibold underline"
          >
            새로고침
          </button>
        </div>
      )}
      {disconnected && (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow-lg"
        >
          실시간 연결이 끊겨 30초마다 새로고침합니다.
        </div>
      )}
    </div>
  );
}
