'use client';

// 앱 시작 부트스트랩 (SOT §8.8, §8.7 K-2·K-3, §14.6 F-2)
// app/layout.tsx에 마운트되어 앱 전체에서 한 번만 동작한다.
//  ① 헬스핑(F-2): app_settings 단일 행 조회 — §8.8 스키마 버전 확인을 겸한다
//  ② §8.8 게이트: schema_version이 기대값보다 낮으면 마이그레이션 안내,
//     높으면 앱 업데이트 안내를 띄우고 진입을 차단한다
//  ③ K-2 자동 백업: 마지막 백업이 7일 이상 지났으면 자동 내보내기 + 알림
//  ④ K-3 보존: 백업 12개 초과분 삭제 (runBackupToFolder 안에서 수행)
// 자동 백업은 백업 폴더가 있는 Tauri에서만 돈다 — 브라우저 개발 모드는 수동
// 내보내기(다운로드)만 지원한다 (§7.14 BackupPanel).

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { exportAll, runHealthPing } from '@/actions/backup';
import { EXPECTED_SCHEMA_VERSION } from '@/lib/constants';
import { isAutoBackupDue, judgeSchemaVersion, type SchemaVerdict } from '@/lib/backup-policy';
import { loadLocalConfig, updateLocalConfig } from '@/lib/local-config';
import { isTauri } from '@/lib/tauri/env';
import { runBackupToFolder } from '@/lib/tauri/fs';

interface Notice {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

// dev 이중 마운트·페이지 이동에서 부트스트랩(특히 자동 백업)이 중복 실행되지 않게
// 모듈 플래그로 막는다. AUTH 실패(로그인 전)는 done으로 치지 않는다 —
// 로그인 후 첫 라우팅에서 재시도해야 §8.8 게이트가 세션 시작 시점에 걸린다.
let bootDone = false;
let bootRunning = false;
let noticeSeq = 0;

export default function AppBootstrap() {
  const pathname = usePathname();
  const [gate, setGate] = useState<{ verdict: SchemaVerdict; dbVersion: number } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  const addNotice = useCallback((kind: Notice['kind'], text: string) => {
    setNotices((prev) => [...prev, { id: ++noticeSeq, kind, text }]);
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  useEffect(() => {
    if (bootDone || bootRunning) return;
    bootRunning = true;

    void (async () => {
      try {
        // ① F-2 헬스핑 + §8.8 스키마 버전 조회 (한 쿼리)
        const ping = await runHealthPing();
        if (!ping.ok) {
          // 로그인·승인 전에는 확인할 수 없다 — 로그인 흐름이 안내하고, 여기서는
          // 로그인 후 라우팅 변화 때 재시도한다 (bootDone을 세우지 않는다)
          if (ping.code === 'AUTH') return;
          bootDone = true;
          addNotice('error', `서버 상태 확인에 실패했습니다: ${ping.error}`);
          return;
        }
        bootDone = true;

        // ② §8.8 게이트 — 불일치면 진입 차단, 자동 백업도 돌리지 않는다
        const verdict = judgeSchemaVersion(ping.data.schemaVersion, EXPECTED_SCHEMA_VERSION);
        if (verdict !== 'ok') {
          setGate({ verdict, dbVersion: ping.data.schemaVersion });
          return;
        }

        // ③·④ K-2 자동 백업 + K-3 보존 — 백업 폴더가 지정된 Tauri에서만
        if (!isTauri()) return;
        const config = await loadLocalConfig();
        if (!config.backupFolder) return; // 미설정 상태는 BackupPanel이 보여준다
        if (!isAutoBackupDue(config.lastBackupAt, new Date())) return;

        const exported = await exportAll();
        if (!exported.ok) {
          addNotice('error', `자동 백업에 실패했습니다: ${exported.error}`);
          return;
        }
        try {
          const { fileName, pruned } = await runBackupToFolder(config.backupFolder, exported.data);
          await updateLocalConfig({ lastBackupAt: exported.data.exportedAt });
          addNotice(
            'info',
            `자동 백업 완료: ${fileName}${pruned.length > 0 ? ` (오래된 백업 ${pruned.length}개 정리)` : ''}`
          );
        } catch (e) {
          addNotice(
            'error',
            `자동 백업 파일 저장에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      } finally {
        bootRunning = false;
      }
    })();
    // 로그인 전(AUTH)에는 라우팅이 바뀔 때마다 재시도한다 — 성공하면 bootDone이 막는다
  }, [pathname, addNotice]);

  return (
    <>
      {gate && <SchemaGate verdict={gate.verdict} dbVersion={gate.dbVersion} />}

      {notices.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {notices.map((n) => (
            <div
              key={n.id}
              role={n.kind === 'error' ? 'alert' : 'status'}
              className={`flex items-start justify-between gap-3 rounded-lg border p-3 text-sm shadow-lg ${
                n.kind === 'error'
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : 'border-green-200 bg-green-50 text-green-800'
              }`}
            >
              <span className="break-all">{n.text}</span>
              <button
                type="button"
                onClick={() => dismissNotice(n.id)}
                aria-label="알림 닫기"
                className="shrink-0 font-bold opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// §8.8: 닫기 버튼 없는 전면 차단 — 해소 전에는 앱을 쓸 수 없다
function SchemaGate({ verdict, dbVersion }: { verdict: SchemaVerdict; dbVersion: number }) {
  const behind = verdict === 'db-behind';
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-grey-900/60 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="schema-gate-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 id="schema-gate-title" className="text-lg font-bold">
          {behind ? '데이터베이스 마이그레이션이 필요합니다' : '앱 업데이트가 필요합니다'}
        </h2>
        <p className="mt-2 text-sm text-grey-600">
          {behind
            ? `데이터베이스 스키마 버전(${dbVersion})이 이 앱이 기대하는 버전(${EXPECTED_SCHEMA_VERSION})보다 낮습니다. 관리자가 supabase/migrations의 마이그레이션을 적용(npm run db:push)한 뒤 앱을 다시 시작하세요.`
            : `데이터베이스 스키마 버전(${dbVersion})이 이 앱이 기대하는 버전(${EXPECTED_SCHEMA_VERSION})보다 높습니다. 다른 PC에서 새 버전이 배포되었습니다 — 최신 버전 앱으로 업데이트한 뒤 다시 시작하세요.`}
        </p>
        <p className="mt-3 text-xs text-grey-400">
          데이터 손상을 막기 위해 버전이 맞을 때까지 진입을 차단합니다 (SOT §8.8).
        </p>
      </div>
    </div>
  );
}
