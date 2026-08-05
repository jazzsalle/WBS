// 노트 화면 (SOT §7.12, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 오늘 날짜(새 노트 기본값, §5.14)는 여기서 Asia/Seoul 달력으로 한 번 고정해 내려준다.
// 클라이언트가 new Date()로 오늘을 다시 만들면 서버 OS 타임존·SSR/CSR에 따라 날짜가 갈린다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getNotesData } from '@/actions/notes';
import { todayISO } from '@/lib/dates';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import NoteScreen from '@/components/notes/NoteScreen';

// R-1 §8.5 구독표의 "노트" 행 그대로 1개. 전체 구독 금지.
// years·members·tasks·milestones는 구독표에 없다 — 남이 이름을 바꿔도 이 화면은 즉시
// 다시 그려지지 않지만, 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·
// 새로고침에 반영된다.
const REALTIME_TABLES = ['notes'];

const CONTENT_CLASS = 'mx-auto max-w-[1600px] p-8';

interface NotesPageProps {
  params: Promise<{ id: string }>;
  /** 역참조 링크(§7.12)가 넘겨주는 초기 선택 노트 */
  searchParams: Promise<{ note?: string | string[] }>;
}

export default async function NotesPage({ params, searchParams }: NotesPageProps) {
  const { id: projectId } = await params;
  const { note: requestedNote } = await searchParams;
  const initialNoteId = Array.isArray(requestedNote) ? (requestedNote[0] ?? null) : (requestedNote ?? null);

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const notes = await getNotesData(projectId);
  // 절대 규칙 5: 빈 목록으로 대체하면 노트가 삭제된 것처럼 보인다. 실패는 그대로 알린다.
  if (!notes.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={notes.error} code={notes.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="mb-4 text-xl font-bold">노트</h1>

      <NoteScreen
        data={notes.data}
        todayISO={todayISO(new Date())}
        initialNoteId={initialNoteId}
      />
    </main>
  );
}
