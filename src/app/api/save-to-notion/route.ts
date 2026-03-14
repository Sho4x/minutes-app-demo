import { NextRequest, NextResponse } from 'next/server';
import type { Session, Organization, Talk } from '@/types';

// ── Notion API helpers ──────────────────────────────────────────────

const NOTION_VERSION = '2022-06-28';

/** rich_text を 2000 文字制限に合わせて分割 */
function richText(text: string) {
  const MAX = 2000;
  const items = [];
  for (let i = 0; i < text.length || items.length === 0; i += MAX) {
    items.push({ type: 'text', text: { content: text.slice(i, i + MAX) } });
  }
  return items;
}

/** paragraph ブロックを生成 */
function paragraph(text: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richText(text) },
  };
}

/** heading_2 ブロックを生成 */
function heading2(text: string) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: richText(text) },
  };
}

// ── Request body型 ──────────────────────────────────────────────────

interface SaveToNotionBody {
  session: Session;
  organization: Organization | null;
  talks: Talk[];
  notionDatabaseId: string;
  notionToken: string;
}

// ── POST handler ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SaveToNotionBody;
    const { session, organization, talks, notionDatabaseId, notionToken } = body;

    if (!notionToken) {
      return NextResponse.json({ error: 'notionToken is required' }, { status: 400 });
    }
    if (!notionDatabaseId) {
      return NextResponse.json({ error: 'notionDatabaseId is required' }, { status: 400 });
    }

    const token = notionToken;

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    };

    // ── データベースプロパティを構築 ──────────────────────────────

    const totalTalks = talks.length;
    const memberCount = session.members?.length ?? 0;
    const agendaCount = session.agendas?.length ?? 0;

    // datetime を Notion date フォーマットに変換
    let notionDate: { start: string } | null = null;
    if (session.datetime) {
      try {
        notionDate = { start: new Date(session.datetime).toISOString() };
      } catch { /* ignore */ }
    }

    const properties: Record<string, unknown> = {
      '会議名':   { title:     [{ text: { content: session.title ?? '' } }] },
      '組織名':   { rich_text: richText(organization?.name ?? '') },
      '部会名':   { rich_text: richText(organization?.groupName ?? '') },
      '日時':     notionDate ? { date: notionDate } : { date: null },
      '場所':     { rich_text: richText(session.location ?? '') },
      '出席者数': { number: memberCount },
      '議題数':   { number: agendaCount },
      '総発言数': { number: totalTalks },
      'ステータス': { select: { name: session.status } },
      'sessionId':  { rich_text: richText(session.id) },
    };

    // ── ページ本文ブロックを構築 ──────────────────────────────────

    const blocks: unknown[] = [];

    for (const agenda of session.agendas ?? []) {
      blocks.push(heading2(`${agenda.order}. ${agenda.title}`));

      const agendaTalks = talks
        .filter(t => t.agendaId === agenda.id)
        .sort((a, b) => a.savedAt.localeCompare(b.savedAt));

      if (agendaTalks.length === 0) {
        blocks.push(paragraph('（発言記録なし）'));
      } else {
        for (const talk of agendaTalks) {
          const member = session.members?.find(m => m.id === talk.speakerId);
          const name = member
            ? member.lastName + (member.firstName ? ` ${member.firstName}` : '')
            : '不明';
          blocks.push(paragraph(`${name}：${talk.text}`));
        }
      }
    }

    // ── Notion にページを作成（初回 100 ブロック）────────────────

    const createRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        parent: { database_id: notionDatabaseId },
        properties,
        children: blocks.slice(0, 100),
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json();
      return NextResponse.json({ error: JSON.stringify(err) }, { status: createRes.status });
    }

    const page = (await createRes.json()) as { id: string; url: string };

    // ── 100 ブロックを超える場合は追記 ───────────────────────────

    for (let i = 100; i < blocks.length; i += 100) {
      const appendRes = await fetch(
        `https://api.notion.com/v1/blocks/${page.id}/children`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
        },
      );
      if (!appendRes.ok) {
        // 一部追記失敗でもページ作成は成功扱い（部分的な保存）
        console.warn('Notion append failed at block', i);
        break;
      }
    }

    return NextResponse.json({ success: true, notionPageUrl: page.url });

  } catch (err) {
    console.error('Notion save error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
