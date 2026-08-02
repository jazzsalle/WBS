'use client';

// 백업·복원 섹션 (SOT §7.14, §8.7 K-1~K-5)
//  - [지금 내보내기](K-1): Tauri는 백업 폴더에 저장(+K-3 보존), 브라우저는 다운로드
//  - 마지막 백업 시각·자동 백업 상태(K-2) 표시
//  - 백업 폴더 변경: Tauri 한정, dialog 플러그인 폴더 선택
//  - [복원](K-4): 파일 선택 → 2단계 확인 → 복원 직전 자동 백업 보존 → 성공/실패 명시
// 데이터 접근은 actions/backup 경유만 한다. 파일·폴더는 lib/tauri/fs, 로컬 설정은
// lib/local-config 경유 — supabase를 직접 호출하지 않는다.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BackupFile, LocalConfig } from '@/types';
import { exportAll, importAll } from '@/actions/backup';
import { EXPECTED_SCHEMA_VERSION } from '@/lib/constants';
import { backupFileName } from '@/lib/backup-policy';
import { loadLocalConfig, updateLocalConfig } from '@/lib/local-config';
import { isTauri } from '@/lib/tauri/env';
import { pickBackupFolder, runBackupToFolder } from '@/lib/tauri/fs';

// 브라우저 개발 모드의 내보내기 경로 — 폴더 접근이 없으므로 다운로드로 저장한다
function downloadJson(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// 복원 후보 파일의 가벼운 구조 확인 — 최종 검증(K-5·25종 테이블)은 서버가 한다.
// 여기서는 엉뚱한 파일을 고른 실수를 2단계 확인 전에 걸러 UX를 지킨다.
function parseRestoreCandidate(text: string): BackupFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('JSON 파일이 아닙니다.');
  }
  const obj = json as Partial<BackupFile> | null;
  if (
    !obj ||
    typeof obj !== 'object' ||
    typeof obj.schemaVersion !== 'number' ||
    typeof obj.exportedAt !== 'string' ||
    typeof obj.exportedBy?.email !== 'string' ||
    typeof obj.tables !== 'object' ||
    obj.tables === null
  ) {
    throw new Error('이 앱의 백업 파일(§8.7 내보내기 JSON)이 아닙니다.');
  }
  return obj as BackupFile;
}

interface RestoreCandidate {
  file: BackupFile;
  sourceName: string;
}

type Message = { kind: 'success' | 'error'; text: string };

export default function BackupPanel() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // isTauri()는 window 의존 — SSR/hydration 불일치를 피해 마운트 후 판정한다
  const [tauri, setTauri] = useState(false);
  const [config, setConfig] = useState<LocalConfig | null>(null);
  const [busy, setBusy] = useState<'export' | 'folder' | 'restore' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  // K-4 2단계 확인 상태
  const [candidate, setCandidate] = useState<RestoreCandidate | null>(null);
  const [restoreStep, setRestoreStep] = useState<1 | 2>(1);
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    setTauri(isTauri());
    loadLocalConfig()
      .then(setConfig)
      .catch((e) => {
        setMessage({
          kind: 'error',
          text: `로컬 설정을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
  }, []);

  // ── K-1 지금 내보내기 ─────────────────────────────────────
  const handleExport = async () => {
    setBusy('export');
    setMessage(null);
    try {
      if (tauri && !config?.backupFolder) {
        setMessage({ kind: 'error', text: '백업 폴더를 먼저 지정하세요.' });
        return;
      }
      const res = await exportAll();
      if (!res.ok) {
        setMessage({ kind: 'error', text: `내보내기에 실패했습니다: ${res.error}` });
        return;
      }
      if (tauri && config?.backupFolder) {
        const { fileName, pruned } = await runBackupToFolder(config.backupFolder, res.data);
        setMessage({
          kind: 'success',
          text: `백업 완료: ${fileName}${pruned.length > 0 ? ` (오래된 백업 ${pruned.length}개 정리)` : ''}`,
        });
      } else {
        downloadJson(backupFileName(res.data.exportedAt), JSON.stringify(res.data));
        setMessage({ kind: 'success', text: '백업 파일이 다운로드되었습니다.' });
      }
      setConfig(await updateLocalConfig({ lastBackupAt: res.data.exportedAt }));
    } catch (e) {
      setMessage({
        kind: 'error',
        text: `백업 파일 저장에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  // ── 백업 폴더 변경 (Tauri 한정) ───────────────────────────
  const handlePickFolder = async () => {
    setBusy('folder');
    setMessage(null);
    try {
      const picked = await pickBackupFolder(config?.backupFolder ?? undefined);
      if (picked) {
        setConfig(await updateLocalConfig({ backupFolder: picked }));
        setMessage({ kind: 'success', text: `백업 폴더를 변경했습니다: ${picked}` });
      }
    } catch (e) {
      setMessage({
        kind: 'error',
        text: `백업 폴더 변경에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  // ── K-4 복원: 파일 선택 → 2단계 확인 → 실행 ───────────────
  const handleRestoreFilePicked = async (file: File | null) => {
    if (!file) return;
    setMessage(null);
    try {
      const parsed = parseRestoreCandidate(await file.text());
      setCandidate({ file: parsed, sourceName: file.name });
      setRestoreStep(1);
      setConfirmText('');
    } catch (e) {
      setMessage({
        kind: 'error',
        text: `복원 파일을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      // 같은 파일을 다시 골라도 change 이벤트가 나가도록 리셋
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const closeRestoreModal = () => {
    setCandidate(null);
    setRestoreStep(1);
    setConfirmText('');
  };

  const handleRestoreExecute = async () => {
    if (!candidate) return;
    setBusy('restore');
    setMessage(null);
    try {
      const res = await importAll(candidate.file);
      if (!res.ok) {
        // K-5 스키마 버전 불일치 거부 메시지도 이 경로로 표시된다
        setMessage({ kind: 'error', text: `복원에 실패했습니다: ${res.error}` });
        closeRestoreModal();
        return;
      }

      // K-4: 서버가 만들어 돌려준 "복원 직전 자동 백업"을 반드시 보존한다 —
      // 이 파일이 있어야 잘못된 복원을 되돌릴 수 있다
      const pre = res.data.preRestoreBackup;
      let preNote: string;
      try {
        if (tauri && config?.backupFolder) {
          const { fileName } = await runBackupToFolder(config.backupFolder, pre);
          setConfig(await updateLocalConfig({ lastBackupAt: pre.exportedAt }));
          preNote = `복원 직전 상태를 ${fileName}(으)로 저장했습니다.`;
        } else {
          downloadJson(backupFileName(pre.exportedAt), JSON.stringify(pre));
          preNote = '복원 직전 상태 백업이 다운로드되었습니다.';
        }
      } catch (e) {
        preNote = `주의: 복원 직전 자동 백업 파일 저장에 실패했습니다 (${e instanceof Error ? e.message : String(e)}).`;
      }

      setMessage({ kind: 'success', text: `복원이 완료되었습니다. ${preNote}` });
      closeRestoreModal();
      router.refresh(); // 전체 대체 복원 — 화면 데이터를 다시 읽는다
    } catch (e) {
      setMessage({
        kind: 'error',
        text: `복원 처리 중 오류가 발생했습니다: ${e instanceof Error ? e.message : String(e)}`,
      });
      closeRestoreModal();
    } finally {
      setBusy(null);
    }
  };

  // K-5: 스키마 버전이 다른 파일은 2단계 확인으로 진입하기 전에 거부한다 (서버도 재검증)
  const candidateVersionMismatch =
    candidate !== null && candidate.file.schemaVersion !== EXPECTED_SCHEMA_VERSION;

  const autoBackupStatus = !tauri
    ? { label: '브라우저 모드 — 자동 백업은 데스크톱 앱에서만 동작합니다.', warn: true }
    : config?.backupFolder
      ? { label: `켜짐 — 7일마다 앱 시작 시 자동 내보내기 (${config.backupFolder})`, warn: false }
      : { label: '꺼짐 — 백업 폴더가 지정되지 않았습니다.', warn: true };

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-bold">백업·복원</h2>
      <p className="mt-1 text-sm text-slate-500">
        무료 플랜에는 DB 백업이 없어 자체 백업이 유일한 안전망입니다 (SOT §8.7).
      </p>

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`mt-4 rounded-lg border p-3 text-sm ${
            message.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {message.text}
        </p>
      )}

      {/* K-2 상태 표시 */}
      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 font-medium text-slate-500">마지막 백업</dt>
          <dd>
            {config?.lastBackupAt
              ? new Date(config.lastBackupAt).toLocaleString('ko-KR')
              : '기록 없음'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 font-medium text-slate-500">자동 백업</dt>
          <dd className={autoBackupStatus.warn ? 'text-amber-600' : 'text-slate-700'}>
            {autoBackupStatus.label}
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleExport}
          disabled={busy !== null}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
        >
          {busy === 'export' ? '내보내는 중…' : '지금 내보내기'}
        </button>

        {tauri && (
          <button
            type="button"
            onClick={handlePickFolder}
            disabled={busy !== null}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === 'folder' ? '선택 중…' : '백업 폴더 변경'}
          </button>
        )}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy !== null}
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
        >
          복원…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void handleRestoreFilePicked(e.target.files?.[0] ?? null)}
        />
      </div>

      {/* K-4 2단계 확인 모달 */}
      {candidate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-title"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 id="restore-title" className="text-lg font-bold">
              전체 복원 — {restoreStep === 1 ? '확인 1/2' : '확인 2/2'}
            </h3>

            <dl className="mt-4 space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-slate-500">파일</dt>
                <dd className="break-all">{candidate.sourceName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-slate-500">내보낸 시각</dt>
                <dd>{new Date(candidate.file.exportedAt).toLocaleString('ko-KR')}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-slate-500">내보낸 사람</dt>
                <dd>{candidate.file.exportedBy.email}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-slate-500">스키마 버전</dt>
                <dd>{candidate.file.schemaVersion}</dd>
              </div>
            </dl>

            {candidateVersionMismatch ? (
              <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                이 백업 파일의 스키마 버전({candidate.file.schemaVersion})이 현재 버전(
                {EXPECTED_SCHEMA_VERSION})과 달라 복원할 수 없습니다 (SOT §8.7 K-5).
              </p>
            ) : restoreStep === 1 ? (
              <p className="mt-4 text-sm text-slate-600">
                복원하면 <strong className="text-red-600">현재 팀 데이터 전체가 이 파일 내용으로
                대체</strong>되고 모든 사용자에게 즉시 반영됩니다. 복원 직전 상태는 자동으로
                백업됩니다.
              </p>
            ) : (
              <div className="mt-4">
                <p className="text-sm text-red-700">
                  마지막 확인입니다. 계속하려면 아래에 <strong>복원</strong>이라고 입력하세요.
                </p>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="복원"
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
                />
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeRestoreModal}
                disabled={busy === 'restore'}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                취소
              </button>
              {!candidateVersionMismatch && restoreStep === 1 && (
                <button
                  type="button"
                  onClick={() => setRestoreStep(2)}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
                >
                  다음
                </button>
              )}
              {!candidateVersionMismatch && restoreStep === 2 && (
                <button
                  type="button"
                  onClick={handleRestoreExecute}
                  disabled={confirmText !== '복원' || busy === 'restore'}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                >
                  {busy === 'restore' ? '복원 중…' : '복원 실행'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
