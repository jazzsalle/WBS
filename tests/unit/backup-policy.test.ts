// 백업 스케줄·보존 정책 순수 함수 테스트 (SOT §8.7 K-2·K-3, §8.8)
// Tauri 실기동 없이 자동 백업 판정·12개 보존·스키마 게이트 판정을 증명한다.

import { describe, expect, it } from 'vitest';
import {
  AUTO_BACKUP_INTERVAL_DAYS,
  BACKUP_KEEP_COUNT,
  backupFileName,
  isAutoBackupDue,
  isBackupFileName,
  judgeSchemaVersion,
  selectBackupsToPrune,
} from '@/lib/backup-policy';

const DAY_MS = 24 * 60 * 60 * 1000;

// 테스트 픽스처: n번째 백업 파일명 (2026-01-01부터 하루 간격)
function backupNameAtDay(day: number): string {
  const iso = new Date(Date.UTC(2026, 0, 1 + day, 3, 0, 0)).toISOString();
  return backupFileName(iso);
}

describe('backupFileName (파일명 규약)', () => {
  it('ISO 타임스탬프의 금지 문자만 치환한다', () => {
    expect(backupFileName('2026-08-02T12:34:56.789Z')).toBe(
      'wbs-backup-2026-08-02T12-34-56-789Z.json'
    );
  });

  it('생성한 파일명은 규약 판정을 통과한다', () => {
    expect(isBackupFileName(backupFileName(new Date().toISOString()))).toBe(true);
  });

  it('사전순 정렬이 시간순 정렬과 일치한다 — 초과분 선정이 이 성질에 의존', () => {
    const earlier = backupFileName('2026-08-02T09:00:00.000Z');
    const later = backupFileName('2026-08-02T10:00:00.000Z');
    const nextDay = backupFileName('2026-08-03T01:00:00.000Z');
    expect(earlier < later).toBe(true);
    expect(later < nextDay).toBe(true);
  });
});

describe('isBackupFileName (남의 파일 보호)', () => {
  it('규약 밖 파일은 백업으로 인식하지 않는다', () => {
    expect(isBackupFileName('readme.txt')).toBe(false);
    expect(isBackupFileName('data.json')).toBe(false);
    expect(isBackupFileName('wbs-backup-hello.json')).toBe(false);
    expect(isBackupFileName('wbs-backup-.json')).toBe(false);
  });
});

describe('selectBackupsToPrune (K-3: 최근 12개 유지)', () => {
  it('12개 이하면 아무것도 지우지 않는다', () => {
    const names = Array.from({ length: BACKUP_KEEP_COUNT }, (_, i) => backupNameAtDay(i));
    expect(selectBackupsToPrune(names)).toEqual([]);
  });

  it('13개째 백업 시 가장 오래된 파일 1개를 고른다', () => {
    const names = Array.from({ length: 13 }, (_, i) => backupNameAtDay(i));
    expect(selectBackupsToPrune(names)).toEqual([backupNameAtDay(0)]);
  });

  it('여러 개 초과분은 오래된 순서대로 전부 고른다', () => {
    const names = Array.from({ length: 15 }, (_, i) => backupNameAtDay(i));
    expect(selectBackupsToPrune(names)).toEqual([
      backupNameAtDay(0),
      backupNameAtDay(1),
      backupNameAtDay(2),
    ]);
  });

  it('입력 순서와 무관하게 가장 오래된 것을 고른다', () => {
    const names = Array.from({ length: 13 }, (_, i) => backupNameAtDay(i)).reverse();
    expect(selectBackupsToPrune(names)).toEqual([backupNameAtDay(0)]);
  });

  it('규약 밖 파일은 개수 계산·삭제 대상 모두에서 제외한다', () => {
    const backups = Array.from({ length: 12 }, (_, i) => backupNameAtDay(i));
    const names = ['0000-앞서는-이름.json', ...backups, 'zzz.txt'];
    // 우리 백업은 12개뿐이므로 남의 파일이 섞여 있어도 아무것도 지우지 않는다
    expect(selectBackupsToPrune(names)).toEqual([]);
  });
});

describe('isAutoBackupDue (K-2: 7일 이상 경과 시 자동 내보내기)', () => {
  const now = new Date('2026-08-02T09:00:00.000Z');

  it('기록이 없으면 백업한다', () => {
    expect(isAutoBackupDue(null, now)).toBe(true);
  });

  it('8일 전이면 백업한다', () => {
    const last = new Date(now.getTime() - 8 * DAY_MS).toISOString();
    expect(isAutoBackupDue(last, now)).toBe(true);
  });

  it("정확히 7일 전이면 백업한다 — '7일 이상 지났으면'", () => {
    const last = new Date(now.getTime() - AUTO_BACKUP_INTERVAL_DAYS * DAY_MS).toISOString();
    expect(isAutoBackupDue(last, now)).toBe(true);
  });

  it('7일 미만이면 백업하지 않는다', () => {
    const justUnder = new Date(
      now.getTime() - AUTO_BACKUP_INTERVAL_DAYS * DAY_MS + 1
    ).toISOString();
    expect(isAutoBackupDue(justUnder, now)).toBe(false);
    const yesterday = new Date(now.getTime() - DAY_MS).toISOString();
    expect(isAutoBackupDue(yesterday, now)).toBe(false);
  });

  it('타임스탬프가 손상됐으면 백업하는 쪽을 택한다', () => {
    expect(isAutoBackupDue('not-a-date', now)).toBe(true);
  });
});

describe('judgeSchemaVersion (§8.8 진입 게이트)', () => {
  it('버전이 같으면 진입을 허용한다', () => {
    expect(judgeSchemaVersion(1, 1)).toBe('ok');
  });

  it('DB가 낮으면 마이그레이션 안내(db-behind)', () => {
    expect(judgeSchemaVersion(1, 2)).toBe('db-behind');
  });

  it('DB가 높으면 앱 업데이트 안내(app-behind)', () => {
    expect(judgeSchemaVersion(2, 1)).toBe('app-behind');
  });
});
