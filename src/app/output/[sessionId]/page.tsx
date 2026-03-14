'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import type { Session, Organization, Talk, Member } from '@/types';
import { sessionsStore, organizationsStore, talksStore } from '@/lib/db';

// ── Google Identity Services (GIS) 型定義 ────────────────────────────

interface TokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
}
interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
}
interface TokenClient {
  requestAccessToken(config?: { prompt?: string }): void;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: TokenClientConfig): TokenClient;
          revoke(token: string, callback: () => void): void;
        };
      };
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDatetime(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', weekday: 'long',
  });
}

function getMemberName(member: Member): string {
  return member.lastName + (member.firstName ? ` ${member.firstName}` : '');
}

const ROLE_LABEL: Record<string, string> = {
  chair: '議長', vice: '副議長', exec: '役員', member: '',
};

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── Types ────────────────────────────────────────────────────────────

interface GoogleUser { name: string; email: string; picture?: string; }

// ── Page ─────────────────────────────────────────────────────────────

export default function OutputPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;
  const router = useRouter();

  // Data
  const [session, setSession] = useState<Session | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [talkMap, setTalkMap] = useState<Map<string, Talk[]>>(new Map());
  const [loading, setLoading] = useState(true);

  // PDF
  const [exporting, setExporting] = useState(false);

  // Google auth
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [gisReady, setGisReady] = useState(false);
  const [sheetsExporting, setSheetsExporting] = useState(false);
  const tokenClientRef = useRef<TokenClient | null>(null);

  // Notion
  const [notionDbId, setNotionDbId] = useState('');
  const [notionToken, setNotionToken] = useState('');
  const [notionSaving, setNotionSaving] = useState(false);
  const [notionPageUrl, setNotionPageUrl] = useState<string | null>(null);
  const [notionError, setNotionError] = useState<string | null>(null);

  const NOTION_STORAGE_KEY = 'notionDatabaseId';
  const NOTION_TOKEN_KEY = 'notionToken';

  // ── Load Notion settings from localStorage ────────────────────────

  useEffect(() => {
    const saved = localStorage.getItem(NOTION_STORAGE_KEY);
    if (saved) setNotionDbId(saved);
    const savedToken = localStorage.getItem(NOTION_TOKEN_KEY);
    if (savedToken) setNotionToken(savedToken);
  }, []);

  // ── Load session ─────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const s = await sessionsStore.getById(sessionId);
      if (!s) { router.push('/'); return; }
      setSession(s);
      const o = await organizationsStore.getById(s.organizationId);
      setOrganization(o ?? null);

      const allTalks = await talksStore.getAll();
      const agendaIds = new Set(s.agendas.map(a => a.id));
      const filtered = allTalks.filter(t => agendaIds.has(t.agendaId));

      const map = new Map<string, Talk[]>();
      for (const a of s.agendas) map.set(a.id, []);
      for (const t of filtered) {
        const list = map.get(t.agendaId);
        if (list) list.push(t);
      }
      for (const [, list] of map) {
        list.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      }
      setTalkMap(map);
      setLoading(false);
    })();
  }, [sessionId, router]);

  // ── Initialize GIS ───────────────────────────────────────────────

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) return;

    loadScript('https://accounts.google.com/gsi/client')
      .then(() => {
        if (!window.google) return;
        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPES,
          callback: async (response) => {
            if (response.error || !response.access_token) return;
            setAccessToken(response.access_token);
            // ユーザー情報を取得
            try {
              const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${response.access_token}` },
              });
              if (res.ok) {
                const data = await res.json() as { name: string; email: string; picture?: string };
                setGoogleUser({ name: data.name, email: data.email, picture: data.picture });
              }
            } catch { /* ignore */ }
          },
        });
        setGisReady(true);
      })
      .catch(console.error);
  }, []);

  // ── Google 認証 ──────────────────────────────────────────────────

  const handleSignIn = () => {
    tokenClientRef.current?.requestAccessToken();
  };

  const handleSwitchAccount = () => {
    tokenClientRef.current?.requestAccessToken({ prompt: 'select_account' });
  };

  const handleSignOut = () => {
    if (accessToken) {
      window.google?.accounts.oauth2.revoke(accessToken, () => {});
    }
    setAccessToken(null);
    setGoogleUser(null);
  };

  // ── PDF export ───────────────────────────────────────────────────

  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      const element = document.getElementById('minutes-preview');
      if (!element) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = {
        margin: [15, 15, 15, 15],
        filename: session ? `${session.title}_議事録.pdf` : '議事録.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
      };
      await html2pdf().set(opts).from(element).save();
    } catch (err) {
      console.error('PDF export error:', err);
    } finally {
      setExporting(false);
    }
  };

  // ── Google Sheets export ─────────────────────────────────────────

  const handleSheetsExport = async () => {
    if (process.env.NEXT_PUBLIC_IS_DEMO === 'true') {
      alert('【デモ版】\nデモ環境のため、Googleスプレッドシートへの出力機能は無効化されています。');
      return;
    }

    if (!session || !accessToken) return;
    setSheetsExporting(true);

    try {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      };

      // 1. スプレッドシートを新規作成
      const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          properties: { title: `議事録：${session.title}`, locale: 'ja_JP' },
        }),
      });
      if (!createRes.ok) throw new Error(`Spreadsheet create failed: ${createRes.status}`);
      const created = await createRes.json() as { spreadsheetId: string };
      const spreadsheetId = created.spreadsheetId;

      // 2. データを構築
      const rows: string[][] = [];

      // ヘッダー情報
      rows.push(['議事録', session.title]);
      if (organization) {
        rows.push(['組織', organization.name + (organization.groupName ? ` / ${organization.groupName}` : '')]);
      }
      if (session.datetime) rows.push(['日時', formatDatetime(session.datetime)]);
      if (session.location) rows.push(['場所', session.location]);
      rows.push([]);

      // 出席者
      rows.push(['【出席者】', '役職']);
      for (const m of session.members) {
        rows.push([getMemberName(m), ROLE_LABEL[m.role] || '一般']);
      }
      rows.push([]);

      // 議題・発言
      for (const [i, agenda] of session.agendas.entries()) {
        rows.push([`【議題 ${i + 1}】${agenda.title}`]);
        const agendaTalks = talkMap.get(agenda.id) ?? [];
        if (agendaTalks.length === 0) {
          rows.push(['（発言記録なし）']);
        } else {
          rows.push(['発言者', '内容']);
          for (const talk of agendaTalks) {
            const member = session.members.find(m => m.id === talk.speakerId);
            const name = member ? getMemberName(member) : '不明';
            rows.push([name, talk.text]);
          }
        }
        rows.push([]);
      }

      // 作成日
      rows.push(['作成日', new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })]);

      // 3. データを書き込む
      const updateRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1?valueInputOption=RAW`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ values: rows }),
        },
      );
      if (!updateRes.ok) throw new Error(`Values update failed: ${updateRes.status}`);

      // 4. スプレッドシートを開く
      window.open(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`, '_blank');
    } catch (err) {
      console.error('Sheets export error:', err);
      alert('スプレッドシートの作成に失敗しました。');
    } finally {
      setSheetsExporting(false);
    }
  };

  // ── Notion save ──────────────────────────────────────────────────

  const handleNotionSave = async () => {
    if (!session || !notionDbId.trim() || !notionToken.trim()) return;
    setNotionSaving(true);
    setNotionError(null);

    // Notion settings を localStorage に保存
    localStorage.setItem(NOTION_STORAGE_KEY, notionDbId.trim());
    localStorage.setItem(NOTION_TOKEN_KEY, notionToken.trim());

    // talks をフラット化
    const allTalks = Array.from(talkMap.values()).flat();

    try {
      const res = await fetch('/api/save-to-notion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session,
          organization,
          talks: allTalks,
          notionDatabaseId: notionDbId.trim(),
          notionToken: notionToken.trim(),
        }),
      });

      const data = (await res.json()) as { success?: boolean; notionPageUrl?: string; error?: string };

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? 'Unknown error');
      }
      setNotionPageUrl(data.notionPageUrl ?? null);
    } catch (err) {
      console.error('Notion save error:', err);
      setNotionError(err instanceof Error ? err.message : 'Notionへの保存に失敗しました');
    } finally {
      setNotionSaving(false);
    }
  };

  // ── Derived stats ────────────────────────────────────────────────

  const totalTalks = Array.from(talkMap.values()).reduce((sum, list) => sum + list.length, 0);
  const memberCount = session?.members.length ?? 0;
  const agendaCount = session?.agendas.length ?? 0;
  const chair = session?.members.find(m => m.role === 'chair');
  const vice = session?.members.find(m => m.role === 'vice');

  // ── Loading ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center">
        <p className="text-zinc-500 text-sm">読み込み中...</p>
      </div>
    );
  }
  if (!session) return null;

  // ── Render ───────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-full { width: 100% !important; }
        }
      `}</style>

      <div className="min-h-screen bg-[#0f0f0f] text-white flex">

        {/* ── Left pane: 議事録プレビュー ── */}
        <main className="flex-1 overflow-y-auto px-8 py-10 print-full">
          <div
            id="minutes-preview"
            style={{
              fontFamily: '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif',
              color: '#111111',
              backgroundColor: '#ffffff',
              padding: '32px',
              borderRadius: '8px',
              lineHeight: '1.8',
            }}
          >
            {/* 表紙ヘッダー */}
            <div style={{ borderBottom: '2px solid #1d4ed8', paddingBottom: '16px', marginBottom: '24px' }}>
              {organization && (
                <p style={{ color: '#4b5563', fontSize: '13px', marginBottom: '4px' }}>
                  {organization.name}{organization.groupName ? ` / ${organization.groupName}` : ''}
                </p>
              )}
              <h1 style={{ fontSize: '22px', fontWeight: 'bold', color: '#111827', margin: '0 0 12px' }}>
                議事録：{session.title}
              </h1>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px', color: '#374151' }}>
                <tbody>
                  {session.datetime && (
                    <tr>
                      <td style={{ padding: '3px 12px 3px 0', fontWeight: '600', whiteSpace: 'nowrap', color: '#6b7280' }}>日時</td>
                      <td style={{ padding: '3px 0', color: '#111827' }}>{formatDatetime(session.datetime)}</td>
                    </tr>
                  )}
                  {session.location && (
                    <tr>
                      <td style={{ padding: '3px 12px 3px 0', fontWeight: '600', whiteSpace: 'nowrap', color: '#6b7280' }}>場所</td>
                      <td style={{ padding: '3px 0', color: '#111827' }}>{session.location}</td>
                    </tr>
                  )}
                  {chair && (
                    <tr>
                      <td style={{ padding: '3px 12px 3px 0', fontWeight: '600', whiteSpace: 'nowrap', color: '#6b7280' }}>議長</td>
                      <td style={{ padding: '3px 0', color: '#111827' }}>{getMemberName(chair)}</td>
                    </tr>
                  )}
                  {vice && (
                    <tr>
                      <td style={{ padding: '3px 12px 3px 0', fontWeight: '600', whiteSpace: 'nowrap', color: '#6b7280' }}>副議長</td>
                      <td style={{ padding: '3px 0', color: '#111827' }}>{getMemberName(vice)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* 出席者一覧 */}
            <section style={{ marginBottom: '28px' }}>
              <h2 style={{ fontSize: '15px', fontWeight: 'bold', color: '#1d4ed8', borderLeft: '4px solid #1d4ed8', paddingLeft: '10px', marginBottom: '10px' }}>
                出席者
              </h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
                {session.members.map(m => {
                  const label = ROLE_LABEL[m.role];
                  return (
                    <span key={m.id} style={{ fontSize: '13px', color: '#374151' }}>
                      {getMemberName(m)}
                      {label && <span style={{ marginLeft: '4px', fontSize: '11px', color: '#6b7280' }}>({label})</span>}
                    </span>
                  );
                })}
              </div>
            </section>

            {/* 議題と発言 */}
            {session.agendas.map((agenda, agendaIdx) => {
              const agendaTalks = talkMap.get(agenda.id) ?? [];
              return (
                <section key={agenda.id} style={{ marginBottom: '28px' }}>
                  <h2 style={{ fontSize: '15px', fontWeight: 'bold', color: '#1d4ed8', borderLeft: '4px solid #1d4ed8', paddingLeft: '10px', marginBottom: '12px' }}>
                    議題 {agendaIdx + 1}：{agenda.title}
                  </h2>
                  {agendaTalks.length === 0 ? (
                    <p style={{ color: '#9ca3af', fontSize: '13px', fontStyle: 'italic' }}>発言記録なし</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {agendaTalks.map(talk => {
                        const member = session.members.find(m => m.id === talk.speakerId);
                        const speakerName = member ? getMemberName(member) : '不明';
                        return (
                          <div key={talk.id} style={{ display: 'flex', gap: '12px', fontSize: '13px', color: '#111827' }}>
                            <span style={{ fontWeight: '600', whiteSpace: 'nowrap', minWidth: '80px', color: '#374151' }}>
                              {speakerName}：
                            </span>
                            <span style={{ whiteSpace: 'pre-wrap', flex: 1, color: '#111827' }}>
                              {talk.text}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}

            {/* フッター */}
            <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '12px', marginTop: '16px', fontSize: '11px', color: '#9ca3af', textAlign: 'right' }}>
              作成日：{new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })}
            </div>
          </div>
        </main>

        {/* ── Right pane: 操作パネル ── */}
        <aside className="no-print w-80 flex-shrink-0 border-l border-zinc-800 bg-zinc-950 px-6 py-8 flex flex-col gap-6 overflow-y-auto">

          {/* ── Google 認証パネル ── */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">Google連携</h3>

            {!gisReady ? (
              <p className="text-xs text-zinc-600">
                {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
                  ? 'Google認証を初期化中...'
                  : 'NEXT_PUBLIC_GOOGLE_CLIENT_IDが未設定です'}
              </p>
            ) : googleUser ? (
              /* 認証済み */
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  {googleUser.picture && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={googleUser.picture} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm text-white font-medium truncate">{googleUser.name}</p>
                    <p className="text-xs text-zinc-500 truncate">{googleUser.email}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleSwitchAccount}
                    className="flex-1 text-xs border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-white py-1.5 rounded-lg transition-colors"
                  >
                    アカウントを切り替え
                  </button>
                  <button
                    onClick={handleSignOut}
                    className="text-xs border border-zinc-700 hover:border-red-600/60 text-zinc-500 hover:text-red-400 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    サインアウト
                  </button>
                </div>
              </div>
            ) : (
              /* 未認証 */
              <button
                onClick={handleSignIn}
                className="w-full flex items-center justify-center gap-2 bg-white hover:bg-zinc-100 text-zinc-800 text-sm font-medium py-2 rounded-lg transition-colors"
              >
                <GoogleIcon />
                Googleアカウントで連携
              </button>
            )}
          </div>

          {/* ── Notion 保存パネル ── */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">Notion連携</h3>

            <div className="space-y-2">
              <label className="text-xs text-zinc-400">Integration Token</label>
              <input
                type="password"
                value={notionToken}
                onChange={e => setNotionToken(e.target.value)}
                placeholder="ntn_..."
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors font-mono"
              />
              <p className="text-xs text-zinc-600">
                ntn_ で始まる Integration Token
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-zinc-400">データベース ID</label>
              <input
                type="text"
                value={notionDbId}
                onChange={e => setNotionDbId(e.target.value)}
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors font-mono"
              />
              <p className="text-xs text-zinc-600">
                Notion DB URL 末尾の32文字
              </p>
            </div>

            <button
              onClick={handleNotionSave}
              disabled={notionSaving || !notionDbId.trim() || !notionToken.trim()}
              className="w-full bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors text-sm flex items-center justify-center gap-2"
            >
              <NotionIcon />
              {notionSaving ? '保存中...' : 'Notionに保存'}
            </button>

            {/* エラー */}
            {notionError && (
              <p className="text-xs text-red-400 break-all">{notionError}</p>
            )}

            {/* 保存済みリンク */}
            {notionPageUrl && (
              <a
                href={notionPageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                <span>✓ Notionページを開く</span>
                <span className="text-zinc-600">↗</span>
              </a>
            )}
          </div>

          {/* ── 操作ボタン ── */}
          <div className="flex flex-col gap-3">
            <button
              onClick={handleSheetsExport}
              disabled={!googleUser || !accessToken || sheetsExporting}
              className="w-full bg-green-700 hover:bg-green-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors text-sm"
            >
              {sheetsExporting ? '作成中...' : '📊 Googleスプレッドシートに出力'}
            </button>
            <button
              onClick={handleExportPdf}
              disabled={exporting}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors text-sm"
            >
              {exporting ? 'PDF生成中...' : '📄 PDFで出力'}
            </button>
            <button
              onClick={() => router.push('/')}
              className="w-full border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white font-medium py-3 rounded-xl transition-colors text-sm"
            >
              ← ホームへ戻る
            </button>
          </div>

          {/* 統計情報 */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">統計情報</h3>
            <ul className="space-y-3">
              <StatRow label="出席者数" value={`${memberCount} 名`} />
              <StatRow label="議題数" value={`${agendaCount} 件`} />
              <StatRow label="発言数" value={`${totalTalks} 件`} />
              {session.datetime && (
                <StatRow
                  label="開催日"
                  value={new Date(session.datetime).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })}
                />
              )}
              {session.location && <StatRow label="場所" value={session.location} />}
            </ul>
          </div>

          {/* 出席者内訳 */}
          {session.members.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">出席者</h3>
              <ul className="space-y-2">
                {session.members.map(m => {
                  const label = ROLE_LABEL[m.role];
                  return (
                    <li key={m.id} className="flex items-center gap-2">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                        style={{ backgroundColor: m.avatarColor }}
                      >
                        {m.lastName[0]}
                      </div>
                      <span className="text-sm text-zinc-200 flex-1 truncate">{getMemberName(m)}</span>
                      {label && <span className="text-xs text-zinc-500 flex-shrink-0">{label}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* 議題サマリー */}
          {session.agendas.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">議題</h3>
              <ol className="space-y-2">
                {session.agendas.map((a, i) => {
                  const count = talkMap.get(a.id)?.length ?? 0;
                  return (
                    <li key={a.id} className="flex gap-2 text-sm">
                      <span className="text-zinc-600 font-mono flex-shrink-0">{i + 1}.</span>
                      <span className="text-zinc-300 flex-1 min-w-0 truncate">{a.title}</span>
                      <span className="text-zinc-600 flex-shrink-0 text-xs">{count}件</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex justify-between items-center">
      <span className="text-sm text-zinc-500">{label}</span>
      <span className="text-sm text-zinc-100 font-medium">{value}</span>
    </li>
  );
}

function NotionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.934zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}
