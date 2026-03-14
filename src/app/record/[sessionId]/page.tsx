'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import type { Session, Organization, Talk, MemberRole } from '@/types';
import { sessionsStore, organizationsStore, talksStore } from '@/lib/db';

// ── Web Speech API type declarations ─────────────────────────────────

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

// ── Punctuation ─────────────────────────────────────────────────────

function insertPunctuation(text: string): string {
  let t = text.trim();
  if (!t) return t;
  // 語尾パターン → 句点
  t = t.replace(
    /(です|ます|した|ました|ください|でしょう|ませんか|ません|ですか|ますか)(?![。、\n])/g,
    '$1。',
  );
  // 助詞 → 読点（句読点・空白に続く場合は除外）
  t = t.replace(/(が|を|は|に|で|と|も|や)(?![。、\n\s])/g, '$1、');
  // 句点の後に改行を挿入
  t = t.replace(/。(?!\n)/g, '。\n');
  return t.trimEnd();
}

// ── Helpers ─────────────────────────────────────────────────────────

type SRConstructor = new () => SpeechRecognition;

function getSpeechRecognition(): SRConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & {
    SpeechRecognition?: SRConstructor;
    webkitSpeechRecognition?: SRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function formatElapsed(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// ── Constants ────────────────────────────────────────────────────────

const ROLE_LABEL: Record<MemberRole, string> = {
  chair: '議長', vice: '副議長', exec: '役員', member: '一般',
};
const ROLE_ORDER: Record<MemberRole, number> = {
  chair: 0, vice: 1, exec: 2, member: 3,
};

// ── Merge tracking ───────────────────────────────────────────────────

interface LastTalkEntry {
  talk: Talk;
  savedAt: number; // ms
}

// ── Page ─────────────────────────────────────────────────────────────

export default function RecordPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;
  const router = useRouter();

  // Data
  const [session, setSession] = useState<Session | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [talks, setTalks] = useState<Talk[]>([]);
  const [loading, setLoading] = useState(true);

  // UI
  const [currentAgendaIdx, setCurrentAgendaIdx] = useState(0);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('unknown');

  // Timer
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef(Date.now());

  // Speech
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState('');
  const isRecordingRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Closure refs (avoid stale closures in callbacks)
  const sessionRef = useRef<Session | null>(null);
  const currentAgendaIdxRef = useRef(0);
  const selectedSpeakerIdRef = useRef('unknown');
  const lastTalkMapRef = useRef(new Map<string, LastTalkEntry>());

  // Scroll anchor
  const bottomRef = useRef<HTMLDivElement>(null);

  // Sync closure refs
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { currentAgendaIdxRef.current = currentAgendaIdx; }, [currentAgendaIdx]);
  useEffect(() => { selectedSpeakerIdRef.current = selectedSpeakerId; }, [selectedSpeakerId]);

  // ── Load session ──────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const s = await sessionsStore.getById(sessionId);
      if (!s) { router.push('/'); return; }
      setSession(s);
      sessionRef.current = s;
      const o = await organizationsStore.getById(s.organizationId);
      setOrganization(o ?? null);
      const allTalks = await talksStore.getAll();
      const agendaIds = new Set(s.agendas.map(a => a.id));
      setTalks(allTalks.filter(t => agendaIds.has(t.agendaId)));
      setLoading(false);
    })();
  }, [sessionId, router]);

  // ── Timer ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (loading) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [loading]);

  // ── Auto scroll ───────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [talks.length, interimText]);

  // ── Save talk (with 3-second merge) ──────────────────────────────

  const saveTalk = useCallback(async (rawText: string) => {
    const s = sessionRef.current;
    if (!s) return;
    const agenda = s.agendas[currentAgendaIdxRef.current];
    if (!agenda) return;

    const text = insertPunctuation(rawText);
    if (!text.trim()) return;

    const agendaId = agenda.id;
    const speakerId = selectedSpeakerIdRef.current;
    const now = Date.now();

    const entry = lastTalkMapRef.current.get(speakerId);
    if (entry && entry.talk.agendaId === agendaId && now - entry.savedAt <= 3000) {
      // マージ
      const merged: Talk = {
        ...entry.talk,
        text: entry.talk.text + text,
        savedAt: new Date(now).toISOString(),
        isMerged: true,
      };
      await talksStore.save(merged);
      setTalks(prev => prev.map(t => t.id === merged.id ? merged : t));
      lastTalkMapRef.current.set(speakerId, { talk: merged, savedAt: now });
      return;
    }

    // 新規トーク
    const newTalk: Talk = {
      id: crypto.randomUUID(),
      agendaId,
      speakerId,
      text,
      savedAt: new Date(now).toISOString(),
      isMerged: false,
    };
    await talksStore.save(newTalk);
    setTalks(prev => [...prev, newTalk]);
    lastTalkMapRef.current.set(speakerId, { talk: newTalk, savedAt: now });
  }, []);

  // ── Speech recognition ────────────────────────────────────────────

  const startRecording = useCallback(() => {
    const SRClass = getSpeechRecognition();
    if (!SRClass) {
      alert('このブラウザは音声認識に対応していません（Chrome推奨）');
      return;
    }

    const recognition = new SRClass();
    recognition.lang = 'ja-JP';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          saveTalk(r[0].transcript);
        } else {
          interim += r[0].transcript;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = () => {
      isRecordingRef.current = false;
      setIsRecording(false);
      setInterimText('');
    };

    recognition.onend = () => {
      // 録音中なら自動再起動（無音タイムアウト対策）
      if (isRecordingRef.current) {
        try { recognition.start(); } catch { /* already started */ }
      }
    };

    recognition.start();
    recognitionRef.current = recognition;
    isRecordingRef.current = true;
    setIsRecording(true);
  }, [saveTalk]);

  const stopRecording = useCallback(() => {
    isRecordingRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsRecording(false);
    setInterimText('');
  }, []);

  // アンマウント時クリーンアップ
  useEffect(() => {
    return () => {
      isRecordingRef.current = false;
      recognitionRef.current?.abort();
    };
  }, []);

  // ── End meeting ───────────────────────────────────────────────────

  const endMeeting = useCallback(async () => {
    stopRecording();
    const s = sessionRef.current;
    if (!s) return;
    await sessionsStore.save({ ...s, status: 'completed', updatedAt: new Date().toISOString() });
    router.push('/');
  }, [stopRecording, router]);

  // ── Loading / null guard ──────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center">
        <p className="text-zinc-500 text-sm">読み込み中...</p>
      </div>
    );
  }
  if (!session) return null;

  // ── Derived values ────────────────────────────────────────────────

  const currentAgenda = session.agendas[currentAgendaIdx] ?? null;
  const currentTalks = currentAgenda
    ? talks.filter(t => t.agendaId === currentAgenda.id)
    : [];

  const getMemberById = (id: string) => session.members.find(m => m.id === id);
  const getMemberName = (speakerId: string) => {
    if (speakerId === 'unknown') return '不明';
    const m = getMemberById(speakerId);
    if (!m) return '不明';
    return m.lastName + (m.firstName ? ` ${m.firstName}` : '');
  };
  const isRightBubble = (speakerId: string) => {
    const r = getMemberById(speakerId)?.role;
    return r === 'chair' || r === 'vice';
  };

  const topRowMembers = session.members
    .filter(m => m.role === 'chair' || m.role === 'vice' || m.role === 'exec')
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const bottomRowMembers = session.members.filter(m => m.role === 'member');

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-[#0f0f0f] text-white flex flex-col overflow-hidden">

      {/* ── Header ── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
        <div className="min-w-0 flex-1 mr-4">
          <p className="text-xs text-zinc-500 truncate">
            {organization?.name}
            {organization?.groupName ? ` | ${organization.groupName}` : ''}
          </p>
          <p className="text-sm font-semibold text-white truncate">{session.title}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-zinc-400 text-sm font-mono tabular-nums">{formatElapsed(elapsed)}</span>
          <button
            onClick={endMeeting}
            className="bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-1.5 rounded-lg font-medium transition-colors"
          >
            会議を終了
          </button>
        </div>
      </header>

      {/* ── Agenda tabs ── */}
      {session.agendas.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-zinc-800 overflow-x-auto flex-shrink-0 no-scrollbar">
          {session.agendas.map((a, i) => (
            <button
              key={a.id}
              onClick={() => setCurrentAgendaIdx(i)}
              className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                i === currentAgendaIdx
                  ? 'bg-blue-600 text-white'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {i + 1}. {a.title}
            </button>
          ))}
          {currentAgendaIdx < session.agendas.length - 1 && (
            <button
              onClick={() => setCurrentAgendaIdx(prev => prev + 1)}
              className="flex-shrink-0 ml-2 text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap"
            >
              次の議題 →
            </button>
          )}
        </div>
      )}

      {/* ── Talk history ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {currentTalks.length === 0 && !interimText && (
          <p className="text-center text-zinc-600 text-sm mt-8">まだ発言がありません</p>
        )}

        {currentTalks.map(talk => {
          const right = isRightBubble(talk.speakerId);
          const member = getMemberById(talk.speakerId);
          return (
            <div key={talk.id} className={`flex items-end gap-2 ${right ? 'flex-row-reverse' : ''}`}>
              {/* アバター */}
              <div
                className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold mb-0.5"
                style={{ backgroundColor: member?.avatarColor ?? '#52525b' }}
              >
                {talk.speakerId === 'unknown' ? '?' : (member?.lastName[0] ?? '?')}
              </div>
              {/* 吹き出し */}
              <div className={`flex flex-col gap-0.5 max-w-[72%] ${right ? 'items-end' : 'items-start'}`}>
                <span className="text-xs text-zinc-500 px-1">{getMemberName(talk.speakerId)}</span>
                <div
                  className={`px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap leading-relaxed ${
                    right
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-zinc-800 text-zinc-100 rounded-bl-sm'
                  }`}
                >
                  {talk.text}
                </div>
              </div>
            </div>
          );
        })}

        {/* 音声認識中のインタリム吹き出し */}
        {interimText && (() => {
          const right = isRightBubble(selectedSpeakerId);
          const member = getMemberById(selectedSpeakerId);
          return (
            <div className={`flex items-end gap-2 ${right ? 'flex-row-reverse' : ''}`}>
              <div
                className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold mb-0.5"
                style={{ backgroundColor: selectedSpeakerId === 'unknown' ? '#52525b' : (member?.avatarColor ?? '#52525b') }}
              >
                {selectedSpeakerId === 'unknown' ? '?' : (member?.lastName[0] ?? '?')}
              </div>
              <div className={`flex flex-col gap-0.5 max-w-[72%] ${right ? 'items-end' : 'items-start'}`}>
                <span className="text-xs text-zinc-500 px-1">{getMemberName(selectedSpeakerId)}</span>
                <div
                  className={`px-3 py-2 rounded-2xl text-sm italic opacity-50 ${
                    right
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-zinc-800 text-zinc-100 rounded-bl-sm'
                  }`}
                >
                  {interimText}
                </div>
              </div>
            </div>
          );
        })()}

        <div ref={bottomRef} />
      </div>

      {/* ── Bottom panel ── */}
      <div className="flex-shrink-0 border-t border-zinc-800 bg-zinc-950">

        {/* 上段: chair / vice / exec */}
        {topRowMembers.length > 0 && (
          <div className="flex gap-2 px-4 pt-3 pb-1 flex-wrap">
            {topRowMembers.map(m => {
              const active = selectedSpeakerId === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedSpeakerId(m.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border-2 transition-all"
                  style={{
                    backgroundColor: active ? m.avatarColor + '22' : 'transparent',
                    borderColor: active ? m.avatarColor : '#3f3f46',
                    color: active ? m.avatarColor : '#71717a',
                  }}
                >
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                    style={{ backgroundColor: m.avatarColor }}
                  >
                    {m.lastName[0]}
                  </span>
                  <span className="font-medium">{m.lastName}</span>
                  <span className="text-xs opacity-70">{ROLE_LABEL[m.role]}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 下段: member（横スクロール）+ 不明（固定末尾） */}
        <div className="flex items-center px-4 pb-3 pt-1 gap-2">
          <div className="flex gap-2 overflow-x-auto flex-1 no-scrollbar">
            {bottomRowMembers.map(m => (
              <button
                key={m.id}
                onClick={() => setSelectedSpeakerId(m.id)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  selectedSpeakerId === m.id
                    ? 'border-zinc-500 bg-zinc-800 text-white'
                    : 'border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'
                }`}
              >
                <span
                  className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                  style={{ backgroundColor: m.avatarColor }}
                >
                  {m.lastName[0]}
                </span>
                {m.lastName}
              </button>
            ))}
          </div>
          {/* 不明（末尾固定） */}
          <button
            onClick={() => setSelectedSpeakerId('unknown')}
            className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              selectedSpeakerId === 'unknown'
                ? 'border-zinc-500 bg-zinc-800 text-zinc-200'
                : 'border-zinc-800 text-zinc-600 hover:border-zinc-600 hover:text-zinc-400'
            }`}
          >
            不明
          </button>
        </div>

        {/* 音声入力パネル */}
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-4">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl flex-shrink-0 transition-all ${
              isRecording
                ? 'bg-red-600 hover:bg-red-500 shadow-lg shadow-red-900/40'
                : 'bg-green-500 hover:bg-green-400'
            }`}
            aria-label={isRecording ? '録音停止' : '録音開始'}
          >
            {isRecording ? '⏹' : '🎤'}
          </button>
          <div className="flex-1 min-w-0 pl-2">
            {isRecording ? (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
                {interimText ? (
                  <span className="text-sm text-zinc-300 italic truncate">{interimText}</span>
                ) : (
                  <span className="text-sm text-zinc-600">音声を待機中...</span>
                )}
              </div>
            ) : (
              <p className="text-sm text-zinc-600">マイクボタンを押して音声入力を開始</p>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
