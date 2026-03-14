'use client';

import { useState, KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Member, MemberRole, Organization, Session, Agenda } from '@/types';
import { organizationsStore, sessionsStore } from '@/lib/db';

const AVATAR_COLORS = [
  '#4f46e5', '#7c3aed', '#db2777', '#dc2626',
  '#d97706', '#16a34a', '#0891b2', '#2563eb',
];
const MAX_MEMBERS = 40;
const STEPS = ['基本情報', 'メンバー', '議題', '確認'] as const;

interface BasicInfo {
  orgName: string;
  groupName: string;
  title: string;
  datetime: string;
  location: string;
}

const ROLE_LABEL: Record<MemberRole, string> = {
  chair: '議長',
  vice: '副議長',
  exec: '役員',
  member: '一般',
};

const ROLE_BADGE: Record<MemberRole, string> = {
  chair: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40',
  vice: 'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  exec: 'bg-purple-500/20 text-purple-400 border border-purple-500/40',
  member: 'bg-zinc-800 text-zinc-500',
};

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  // Step 1
  const [basicInfo, setBasicInfo] = useState<BasicInfo>({
    orgName: '',
    groupName: '',
    title: '',
    datetime: '',
    location: '',
  });

  // Step 2
  const [members, setMembers] = useState<Member[]>([]);
  const [memberForm, setMemberForm] = useState({ lastName: '', firstName: '', email: '' });
  const [memberError, setMemberError] = useState('');

  // Step 3
  const [agendaInput, setAgendaInput] = useState('');
  const [agendaTitles, setAgendaTitles] = useState<string[]>([]);

  // Step 4
  const [saving, setSaving] = useState(false);

  const step1Valid = basicInfo.orgName.trim() !== '' && basicInfo.title.trim() !== '';

  // ── Step 2 helpers ──────────────────────────────────────────────

  const addMember = () => {
    if (!memberForm.lastName.trim()) {
      setMemberError('姓は必須です');
      return;
    }
    if (members.length >= MAX_MEMBERS) {
      setMemberError(`メンバーは${MAX_MEMBERS}名までです`);
      return;
    }
    const newMember: Member = {
      id: crypto.randomUUID(),
      lastName: memberForm.lastName.trim(),
      firstName: memberForm.firstName.trim(),
      email: memberForm.email.trim(),
      role: 'member',
      avatarColor: AVATAR_COLORS[members.length % AVATAR_COLORS.length],
    };
    setMembers(prev => [...prev, newMember]);
    setMemberForm({ lastName: '', firstName: '', email: '' });
    setMemberError('');
  };

  const setRole = (id: string, newRole: MemberRole) => {
    setMembers(prev => {
      const target = prev.find(m => m.id === id);
      if (!target) return prev;
      const isToggleOff = target.role === newRole;
      const finalRole: MemberRole = isToggleOff ? 'member' : newRole;
      return prev.map(m => {
        if (m.id === id) return { ...m, role: finalRole };
        // chair / vice は各1名のみ — 他のメンバーから同じ役職を解除
        if (!isToggleOff && (newRole === 'chair' || newRole === 'vice') && m.role === newRole) {
          return { ...m, role: 'member' };
        }
        return m;
      });
    });
  };

  const removeMember = (id: string) => setMembers(prev => prev.filter(m => m.id !== id));

  // ── Step 3 helpers ──────────────────────────────────────────────

  const addAgenda = () => {
    if (!agendaInput.trim()) return;
    setAgendaTitles(prev => [...prev, agendaInput.trim()]);
    setAgendaInput('');
  };

  const handleAgendaKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); addAgenda(); }
  };

  // ── Step 4 ──────────────────────────────────────────────────────

  const handleStart = async () => {
    setSaving(true);
    try {
      const orgId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const now = new Date().toISOString();

      const org: Organization = {
        id: orgId,
        name: basicInfo.orgName.trim(),
        groupName: basicInfo.groupName.trim(),
      };

      const agendas: Agenda[] = agendaTitles.map((title, i) => ({
        id: crypto.randomUUID(),
        sessionId,
        order: i + 1,
        title,
        talks: [],
      }));

      const session: Session = {
        id: sessionId,
        organizationId: orgId,
        title: basicInfo.title.trim(),
        datetime: basicInfo.datetime,
        location: basicInfo.location.trim(),
        members,
        agendas,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };

      await organizationsStore.save(org);
      await sessionsStore.save(session);
      router.push(`/record/${sessionId}`);
    } catch (err) {
      console.error(err);
      setSaving(false);
    }
  };

  // ── Shared input class ──────────────────────────────────────────

  const inputCls =
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors';

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white">
      <div className="max-w-2xl mx-auto px-4 py-10">

        {/* ── Step Indicator ── */}
        <div className="flex items-start mb-10">
          {STEPS.map((label, i) => (
            <div key={i} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors ${
                    i < step
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : i === step
                      ? 'border-blue-500 text-blue-400 bg-transparent'
                      : 'border-zinc-700 text-zinc-600 bg-transparent'
                  }`}
                >
                  {i < step ? '✓' : i + 1}
                </div>
                <span
                  className={`text-xs whitespace-nowrap ${
                    i === step ? 'text-blue-400' : i < step ? 'text-zinc-400' : 'text-zinc-600'
                  }`}
                >
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-px mx-2 mt-[-1rem] ${i < step ? 'bg-blue-600' : 'bg-zinc-800'}`} />
              )}
            </div>
          ))}
        </div>

        {/* ── Step 1: 基本情報 ── */}
        {step === 0 && (
          <div className="space-y-6">
            <h2 className="text-xl font-semibold text-zinc-100">基本情報</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  組織名 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={basicInfo.orgName}
                  onChange={e => setBasicInfo(p => ({ ...p, orgName: e.target.value }))}
                  placeholder="例：〇〇株式会社"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">部会名</label>
                <input
                  type="text"
                  value={basicInfo.groupName}
                  onChange={e => setBasicInfo(p => ({ ...p, groupName: e.target.value }))}
                  placeholder="例：第一営業部"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  会議名 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={basicInfo.title}
                  onChange={e => setBasicInfo(p => ({ ...p, title: e.target.value }))}
                  placeholder="例：2024年1月 月次会議"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">日時</label>
                <input
                  type="datetime-local"
                  value={basicInfo.datetime}
                  onChange={e => setBasicInfo(p => ({ ...p, datetime: e.target.value }))}
                  className={`${inputCls} [color-scheme:dark]`}
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">場所</label>
                <input
                  type="text"
                  value={basicInfo.location}
                  onChange={e => setBasicInfo(p => ({ ...p, location: e.target.value }))}
                  placeholder="例：第3会議室"
                  className={inputCls}
                />
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: メンバー登録 ── */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-zinc-100">メンバー登録</h2>
              <span className={`text-sm tabular-nums ${members.length >= MAX_MEMBERS ? 'text-red-400' : 'text-zinc-500'}`}>
                {members.length} / {MAX_MEMBERS} 名
              </span>
            </div>

            {/* 追加フォーム */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    姓 <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={memberForm.lastName}
                    onChange={e => setMemberForm(p => ({ ...p, lastName: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') addMember(); }}
                    placeholder="山田"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">名</label>
                  <input
                    type="text"
                    value={memberForm.firstName}
                    onChange={e => setMemberForm(p => ({ ...p, firstName: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') addMember(); }}
                    placeholder="太郎"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">メールアドレス</label>
                <input
                  type="email"
                  value={memberForm.email}
                  onChange={e => setMemberForm(p => ({ ...p, email: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addMember(); }}
                  placeholder="taro@example.com"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
              {memberError && <p className="text-red-400 text-xs">{memberError}</p>}
              <button
                onClick={addMember}
                disabled={members.length >= MAX_MEMBERS}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white rounded-lg py-2 text-sm font-medium transition-colors"
              >
                追加
              </button>
            </div>

            {/* メンバー一覧 */}
            {members.length === 0 ? (
              <p className="text-center text-zinc-600 text-sm py-6">メンバーが登録されていません</p>
            ) : (
              <ul className="space-y-2">
                {members.map(m => (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3"
                  >
                    {/* アバター */}
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                      style={{ backgroundColor: m.avatarColor }}
                    >
                      {m.lastName[0]}
                    </div>
                    {/* 名前 */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">
                        {m.lastName}{m.firstName ? ` ${m.firstName}` : ''}
                      </p>
                      {m.email && <p className="text-xs text-zinc-500 truncate">{m.email}</p>}
                    </div>
                    {/* 役職ボタン */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {(['chair', 'vice', 'exec'] as MemberRole[]).map(r => (
                        <button
                          key={r}
                          onClick={() => setRole(m.id, r)}
                          className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                            m.role === r
                              ? ROLE_BADGE[r]
                              : 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
                          }`}
                        >
                          {ROLE_LABEL[r]}
                        </button>
                      ))}
                      <button
                        onClick={() => removeMember(m.id)}
                        className="ml-1 text-zinc-600 hover:text-red-400 transition-colors text-base leading-none"
                        aria-label="削除"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── Step 3: 議題リスト ── */}
        {step === 2 && (
          <div className="space-y-6">
            <h2 className="text-xl font-semibold text-zinc-100">議題リスト</h2>
            <div className="flex gap-2">
              <input
                type="text"
                value={agendaInput}
                onChange={e => setAgendaInput(e.target.value)}
                onKeyDown={handleAgendaKey}
                placeholder="議題を入力..."
                className={inputCls}
              />
              <button
                onClick={addAgenda}
                className="flex-shrink-0 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-5 font-medium transition-colors"
              >
                追加
              </button>
            </div>
            {agendaTitles.length === 0 ? (
              <p className="text-center text-zinc-600 text-sm py-6">議題が登録されていません</p>
            ) : (
              <ol className="space-y-2">
                {agendaTitles.map((title, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3"
                  >
                    <span className="text-zinc-500 text-sm font-mono w-5 text-right flex-shrink-0">
                      {i + 1}.
                    </span>
                    <span className="flex-1 text-sm text-white">{title}</span>
                    <button
                      onClick={() => setAgendaTitles(prev => prev.filter((_, idx) => idx !== i))}
                      className="text-zinc-600 hover:text-red-400 transition-colors text-base leading-none"
                      aria-label="削除"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {/* ── Step 4: 確認 ── */}
        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-xl font-semibold text-zinc-100">確認</h2>

            {/* 組織情報 */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">組織情報</h3>
              <p className="text-white font-medium">{basicInfo.orgName}</p>
              {basicInfo.groupName && <p className="text-zinc-400 text-sm">{basicInfo.groupName}</p>}
            </section>

            {/* 会議情報 */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">会議情報</h3>
              <p className="text-white font-medium">{basicInfo.title}</p>
              {basicInfo.datetime && (
                <p className="text-zinc-400 text-sm">
                  {new Date(basicInfo.datetime).toLocaleString('ja-JP', {
                    year: 'numeric', month: 'long', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </p>
              )}
              {basicInfo.location && (
                <p className="text-zinc-400 text-sm">📍 {basicInfo.location}</p>
              )}
            </section>

            {/* メンバー */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">
                メンバー ({members.length} 名)
              </h3>
              {members.length === 0 ? (
                <p className="text-zinc-600 text-sm">メンバーなし</p>
              ) : (
                <ul className="space-y-2">
                  {members.map(m => (
                    <li key={m.id} className="flex items-center gap-3">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                        style={{ backgroundColor: m.avatarColor }}
                      >
                        {m.lastName[0]}
                      </div>
                      <span className="flex-1 text-sm text-white">
                        {m.lastName}{m.firstName ? ` ${m.firstName}` : ''}
                      </span>
                      {m.role !== 'member' && (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${ROLE_BADGE[m.role]}`}>
                          {ROLE_LABEL[m.role]}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 議題 */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">
                議題 ({agendaTitles.length} 件)
              </h3>
              {agendaTitles.length === 0 ? (
                <p className="text-zinc-600 text-sm">議題なし</p>
              ) : (
                <ol className="space-y-1.5">
                  {agendaTitles.map((title, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <span className="text-zinc-500 font-mono">{i + 1}.</span>
                      <span className="text-white">{title}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}

        {/* ── ナビゲーション ── */}
        <div className="flex justify-between mt-8">
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={step === 0}
            className="px-6 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            戻る
          </button>

          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={step === 0 && !step1Valid}
              className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white font-medium transition-colors"
            >
              次へ
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={saving}
              className="px-6 py-2.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white font-medium transition-colors"
            >
              {saving ? '保存中...' : '会議を開始する'}
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
