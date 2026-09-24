'use client';

// 설정 > 사내 명부 연동 (SOT §7.14, §6.13.3 HR-10~HR-13)
// HR API 키를 OS 키체인에 넣고(lib/hr-key), [연결 확인]으로 HR을 한 번 불러 본다.
//
// 키 원문은 이 컴포넌트 상태에 두지 않는다. 마운트 시 loadHrApiKey로 "있는지·어디에·끝 4자리"만
// 뽑고, [연결 확인]을 누를 때 키체인에서 다시 읽어 서버 액션 인자로 바로 넘긴다(HR-13) —
// 저장된 값을 입력칸에 되채우지 않는다(§7.14). HR 호출은 클릭 핸들러에서만 한다(HR-7).
// 키를 웹 스토리지·로그에 두지 않는다(HR-12).

import { useEffect, useState } from 'react';
import { fetchHrDirectory } from '@/actions/team';
import { clearHrApiKey, loadHrApiKey, maskApiKey, saveHrApiKey, type HrKeyStorage } from '@/lib/hr-key';
import { isTauri } from '@/lib/tauri/env';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';

// Tauri 밖에서는 키체인이 없다. 조용히 못 쓰는 상태로 두지 않고 그 사실을 화면에 적는다(HR-12)
const SESSION_ONLY_NOTICE =
  'Tauri 환경이 아니라 키를 OS 키체인에 저장하지 않습니다. 이 창에서만 유지됩니다.';

interface KeyStatus {
  storage: HrKeyStorage;
  /** 등록된 키의 끝 4자리 표시. 미등록이면 null — 원문은 여기 들어오지 않는다 */
  masked: string | null;
}

interface CheckSuccess {
  users: number;
  unreadable: number;
  count: number | null;
  rowCount: number;
  countMismatch: boolean;
}

type Message = { kind: 'success' | 'notice'; text: string };

export default function HrApiKeyPanel() {
  // isTauri()는 window 의존 — SSR/hydration 불일치를 피해 마운트 후 판정한다
  const [tauri, setTauri] = useState(false);
  // null = 키체인을 아직 읽는 중. 읽기 전에 [저장]을 눌러도 되지만 상태 표시는 기다린다
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<'save' | 'check' | 'clear' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<CheckSuccess | null>(null);

  useEffect(() => {
    setTauri(isTauri());
    loadHrApiKey()
      .then(({ key, storage }) => {
        setStatus({ storage, masked: key === null ? null : maskApiKey(key) });
      })
      .catch((e) => {
        // 키체인 읽기 실패를 "미등록"으로 오해하게 두지 않는다(절대 규칙 5)
        setError(`저장된 키를 확인하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
        setStatus({ storage: 'session', masked: null });
      });
  }, []);

  const registered = status?.masked !== null && status?.masked !== undefined;

  const handleSave = async () => {
    const value = input;
    if (value.trim().length === 0) {
      setError('HR API 키를 입력하세요.');
      return;
    }
    setBusy('save');
    setError(null);
    setMessage(null);
    setCheckResult(null);
    try {
      const { storage } = await saveHrApiKey(value);
      setStatus({ storage, masked: maskApiKey(value.trim()) });
      setInput('');
      setMessage(
        storage === 'session'
          ? { kind: 'notice', text: SESSION_ONLY_NOTICE }
          : { kind: 'success', text: 'HR API 키를 OS 키체인에 저장했습니다.' }
      );
    } catch (e) {
      setError(`키를 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleCheck = async () => {
    setBusy('check');
    setError(null);
    setMessage(null);
    setCheckResult(null);
    try {
      // 저장된 원문은 상태에 없다 — 여기서 키체인을 다시 읽어 서버 액션 인자로만 쓴다(HR-13)
      const { key } = await loadHrApiKey();
      if (key === null) {
        setStatus({ storage: tauri ? 'keychain' : 'session', masked: null });
        setError('등록된 HR API 키가 없습니다. 먼저 키를 저장하세요.');
        return;
      }
      const res = await fetchHrDirectory(key, null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      let users = 0;
      let unreadable = 0;
      for (const entry of res.data.entries) {
        if (entry.kind === 'user') users++;
        else unreadable++;
      }
      setCheckResult({
        users,
        unreadable,
        count: res.data.count,
        rowCount: res.data.rowCount,
        countMismatch: res.data.countMismatch,
      });
    } catch (e) {
      setError(`연결 확인 중 오류가 발생했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy('clear');
    setError(null);
    setMessage(null);
    setCheckResult(null);
    try {
      await clearHrApiKey();
      setStatus({ storage: tauri ? 'keychain' : 'session', masked: null });
      setMessage({ kind: 'success', text: 'HR API 키를 삭제했습니다.' });
    } catch (e) {
      setError(`키를 삭제하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const checkDisabledReason =
    status === null
      ? '저장된 키를 확인하는 중입니다.'
      : !registered
        ? '키를 먼저 등록해야 연결을 확인할 수 있습니다.'
        : null;

  return (
    <section className="mt-8 rounded-2xl border border-grey-200 bg-surface p-6">
      <h2 className="text-lg font-bold">사내 명부 연동</h2>
      <p className="mt-1 text-sm text-grey-500">
        인력 화면의 [사내 명부에서 추가]가 쓰는 HR API 키입니다 (SOT §6.13).
      </p>

      {/* 고정 안내 ①·② — §7.14가 화면에 적으라고 한 두 문장 */}
      <ul className="mt-4 space-y-1 rounded-lg bg-grey-50 p-3 text-sm text-grey-600">
        <li>
          <span className="font-medium text-grey-700">발급 방법:</span>{' '}
          <code className="rounded bg-surface px-1 py-0.5 text-xs">
            hr.unes.kr 로그인 → 🔑 API 키 → 용도 입력 → 이메일 인증
          </code>{' '}
          — 키는 발급 화면에서 한 번만 보입니다.
        </li>
        <li>
          키는 OS 키체인에만 저장되며 앱 DB·백업 파일에 들어가지 않습니다 — PC마다 등록해야 합니다.
        </li>
      </ul>

      {error && <ErrorBanner message={error} className="mt-4" onDismiss={() => setError(null)} />}

      {message && (
        <p
          role="status"
          className={`mt-4 rounded-lg border p-3 text-sm ${
            message.kind === 'notice'
              ? 'border-orange-200 bg-orange-50 text-orange-800'
              : 'border-green-200 bg-green-50 text-green-800'
          }`}
        >
          {message.text}
        </p>
      )}

      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 font-medium text-grey-500">상태</dt>
          <dd>
            {status === null ? (
              <span className="text-grey-400">확인 중…</span>
            ) : registered ? (
              <>
                등록됨 <code className="rounded bg-grey-100 px-1">{status.masked}</code>
                <span className="ml-2 text-xs text-grey-500">
                  ({status.storage === 'keychain' ? 'OS 키체인' : '이 창에서만 유지'})
                </span>
              </>
            ) : (
              '미등록'
            )}
          </dd>
        </div>
        {!tauri && status !== null && (
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 font-medium text-grey-500">환경</dt>
            <dd className="text-orange-600">{SESSION_ONLY_NOTICE}</dd>
          </div>
        )}
      </dl>

      {/* 입력칸은 항상 빈 값으로 시작한다 — 저장된 키를 되채우지 않는다(§7.14) */}
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="font-medium text-grey-700">
            {registered ? '새 키로 교체' : 'HR API 키'}
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy !== null}
            placeholder="발급받은 키를 붙여넣으세요"
            className="w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none disabled:bg-grey-50"
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy !== null || input.trim().length === 0}>
          {busy === 'save' ? '저장 중…' : '저장'}
        </Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => void handleCheck()}
          disabled={busy !== null || checkDisabledReason !== null}
          title={checkDisabledReason ?? undefined}
        >
          {busy === 'check' ? '확인 중…' : '연결 확인'}
        </Button>
        <Button
          variant="danger"
          onClick={() => void handleClear()}
          disabled={busy !== null || !registered}
        >
          {busy === 'clear' ? '삭제 중…' : '키 삭제'}
        </Button>
        {checkDisabledReason && (
          <span className="text-xs text-grey-500">{checkDisabledReason}</span>
        )}
      </div>

      {checkResult && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"
        >
          <p className="font-semibold">연결 성공 — {checkResult.users}명</p>
          {checkResult.unreadable > 0 && (
            <p className="mt-1">읽을 수 없음 {checkResult.unreadable}건</p>
          )}
          {checkResult.countMismatch && (
            <p className="mt-1 text-orange-800">
              HR이 알린 인원({checkResult.count ?? '없음'})과 받은 행 수({checkResult.rowCount})가
              다릅니다.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
