'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Organization, Session } from '@/types';
import { organizationsStore, sessionsStore } from '@/lib/db';

const STATUS_BADGE: Record<Session['status'], { label: string; cls: string }> = {
  draft:     { label: '下書き',   cls: 'bg-zinc-700 text-zinc-300' },
  active:    { label: '進行中',   cls: 'bg-green-600/20 text-green-400 border border-green-600/40' },
  completed: { label: '完了',     cls: 'bg-blue-600/20 text-blue-400 border border-blue-600/40' },
};

function formatDatetime(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function Home() {
  const router = useRouter();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const orgs = await organizationsStore.getAll();
      setOrganization(orgs[0] ?? null);
      const all = await sessionsStore.getAll();
      // 新しい順
      all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setSessions(all);
      setLoading(false);
    })();
  }, []);

  const handleSessionClick = (session: Session) => {
    if (session.status === 'active') {
      router.push(`/record/${session.id}`);
    } else {
      router.push(`/output/${session.id}`);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white">
      <div className="max-w-2xl mx-auto px-4 py-12">

        {/* ── 組織見出し ── */}
        <div className="mb-10">
          <h1 className="text-2xl font-bold text-white">
            {organization?.name ?? '組織名未設定'}
          </h1>
          {organization?.groupName && (
            <p className="text-zinc-500 text-sm mt-1">{organization.groupName}</p>
          )}
        </div>

        {/* ── 新規セッション作成カード ── */}
        <button
          onClick={() => router.push('/setup')}
          className="w-full text-left bg-zinc-900 border border-zinc-800 hover:border-blue-600 rounded-xl p-5 mb-8 transition-colors group"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-base font-semibold text-white group-hover:text-blue-400 transition-colors">
                新規セッション作成
              </p>
              <p className="text-sm text-zinc-500 mt-0.5">会議の基本情報・メンバー・議題を設定して録音を開始</p>
            </div>
            <span className="text-zinc-600 group-hover:text-blue-400 text-xl transition-colors">＋</span>
          </div>
        </button>

        {/* ── 過去セッション一覧 ── */}
        <section>
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-4">
            過去のセッション
          </h2>

          {loading ? (
            <p className="text-zinc-600 text-sm text-center py-8">読み込み中...</p>
          ) : sessions.length === 0 ? (
            <p className="text-zinc-600 text-sm text-center py-8">セッションがありません</p>
          ) : (
            <ul className="space-y-3">
              {sessions.map(session => {
                const badge = STATUS_BADGE[session.status];
                return (
                  <li key={session.id}>
                    <button
                      onClick={() => handleSessionClick(session)}
                      className="w-full text-left bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-xl px-5 py-4 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-white truncate">{session.title}</p>
                          {session.datetime && (
                            <p className="text-xs text-zinc-500 mt-0.5">{formatDatetime(session.datetime)}</p>
                          )}
                          {session.location && (
                            <p className="text-xs text-zinc-600 mt-0.5 truncate">📍 {session.location}</p>
                          )}
                        </div>
                        <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-xs text-zinc-600">
                          出席者 {session.members.length} 名
                        </span>
                        <span className="text-xs text-zinc-600">
                          議題 {session.agendas.length} 件
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

      </div>
    </div>
  );
}
