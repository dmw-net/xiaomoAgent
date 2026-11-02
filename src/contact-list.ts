import { db } from "./db.ts";
import { conversationReadMap } from "./contacts.ts";
import { listConversationsForContacts } from "./conversations.ts";

/** 联系人列表行需要的一份批量快照，避免每个联系人重复查会话、预览和未读。 */
export type ContactMessagePreview = {
  text: string;
  at: number;
  role: string;
  messageChannel: string;
  conversationId: string | null;
  channel: string | null;
  kind: string | null;
  title: string | null;
};

export type ContactConversationSnapshot = {
  id: string;
  channel: string;
  kind: string;
  title: string;
  enabled: boolean;
  leftAt: number | null;
  createdAt: number;
  latest: { text: string; at: number; role: string } | null;
  unread: number;
};

export type ContactListSnapshot = {
  latest: ContactMessagePreview | null;
  conversations: ContactConversationSnapshot[];
  unread: number;
};

type LatestMessageRow = {
  source: "contact" | "conversation";
  contact_id: string;
  conversation_id: string | null;
  text: string;
  created_at: number;
  role: string;
  message_channel: string;
  conversation_channel: string | null;
  conversation_kind: string | null;
  conversation_title: string | null;
};

const UNREAD_CHUNK = 300;

/**
 * 一次查询后的内存索引，供 `/api/contacts` 使用。
 * 查询次数固定为：会话 1、预览 1、未读 1～N（N 只由会话条数超过 SQLite 参数上限触发）。
 */
export function buildContactListSnapshots(contactIds: string[]): Map<string, ContactListSnapshot> {
  const ids = [...new Set(contactIds.filter((id) => id !== ""))];
  const out = new Map<string, ContactListSnapshot>();
  for (const id of ids) out.set(id, { latest: null, conversations: [], unread: 0 });
  if (ids.length === 0) return out;

  const conversationsByContact = listConversationsForContacts(ids);
  const conversations = [...conversationsByContact.values()].flat();
  const conversationById = new Map(conversations.map((conv) => [conv.id, conv]));
  const marks = ids.map(() => "?").join(",");

  // 同一个窗口查询同时取「联系人最新一条」和「每个会话最新一条」。
  // 用相关子查询各走一次 recent 索引，避免窗口函数把整段历史全扫一遍再排序。
  const conversationIds = conversations.map((conv) => conv.id);
  const conversationMarks = conversationIds.map(() => "?").join(",");
  const latestRows = conversationIds.length === 0
    ? db.prepare(
      `SELECT 'contact' AS source, m.contact_id, m.conversation_id, m.text, m.created_at, m.role,
              m.channel AS message_channel, c.channel AS conversation_channel,
              c.kind AS conversation_kind, c.title AS conversation_title
       FROM messages m
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE m.contact_id IN (${marks}) AND m.superseded_at IS NULL AND m.kind != 'tool'
         AND m.id = (
           SELECT m2.id FROM messages m2
           WHERE m2.contact_id = m.contact_id AND m2.superseded_at IS NULL AND m2.kind != 'tool'
           ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1
         )`,
    ).all(...ids) as LatestMessageRow[]
    : db.prepare(
      `SELECT 'contact' AS source, m.contact_id, m.conversation_id, m.text, m.created_at, m.role,
              m.channel AS message_channel, c.channel AS conversation_channel,
              c.kind AS conversation_kind, c.title AS conversation_title
       FROM messages m
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE m.contact_id IN (${marks}) AND m.superseded_at IS NULL AND m.kind != 'tool'
         AND m.id = (
           SELECT m2.id FROM messages m2
           WHERE m2.contact_id = m.contact_id AND m2.superseded_at IS NULL AND m2.kind != 'tool'
           ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1
         )
       UNION ALL
       SELECT 'conversation' AS source, m.contact_id, m.conversation_id, m.text, m.created_at, m.role,
              m.channel AS message_channel, c.channel AS conversation_channel,
              c.kind AS conversation_kind, c.title AS conversation_title
       FROM messages m
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id IN (${conversationMarks}) AND m.superseded_at IS NULL AND m.kind != 'tool'
         AND m.id = (
           SELECT m2.id FROM messages m2
           WHERE m2.conversation_id = m.conversation_id AND m2.superseded_at IS NULL AND m2.kind != 'tool'
           ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1
         )`,
    ).all(...ids, ...conversationIds) as LatestMessageRow[];
  const latestByContact = new Map<string, ContactMessagePreview>();
  const latestByConversation = new Map<string, { text: string; at: number; role: string }>();
  for (const row of latestRows) {
    if (row.source === "contact") {
      latestByContact.set(row.contact_id, {
        text: row.text,
        at: Number(row.created_at),
        role: row.role,
        messageChannel: row.message_channel ?? "",
        conversationId: row.conversation_id,
        channel: row.conversation_channel,
        kind: row.conversation_kind,
        title: row.conversation_title,
      });
    }
    if (row.source === "conversation" && row.conversation_id !== null && conversationById.has(row.conversation_id)) {
      latestByConversation.set(row.conversation_id, {
        text: row.text,
        at: Number(row.created_at),
        role: row.role,
      });
    }
  }

  const readMap = conversationReadMap();
  const unreadByConversation = new Map<string, number>();
  for (let start = 0; start < conversations.length; start += UNREAD_CHUNK) {
    const chunk = conversations.slice(start, start + UNREAD_CHUNK);
    if (chunk.length === 0) continue;
    const cursorSql = chunk.map(() => "(?, ?)").join(",");
    const conversationMarks = chunk.map(() => "?").join(",");
    const args = [
      ...chunk.flatMap((conv) => [conv.id, readMap[conv.id] ?? -1]),
      ...chunk.map((conv) => conv.id),
    ];
    const rows = db.prepare(
      `WITH cursors(conversation_id, last_id) AS (VALUES ${cursorSql}),
            fallback AS (
              SELECT conversation_id, MAX(id) AS last_user_id
              FROM messages
              WHERE conversation_id IN (${conversationMarks}) AND role = 'user'
              GROUP BY conversation_id
            ),
            effective AS (
              SELECT c.conversation_id,
                     CASE WHEN c.last_id < 0 THEN COALESCE(f.last_user_id, 0) ELSE c.last_id END AS last_id
              FROM cursors c LEFT JOIN fallback f ON f.conversation_id = c.conversation_id
            )
       SELECT m.conversation_id, COUNT(*) AS n
       FROM messages m JOIN effective e ON e.conversation_id = m.conversation_id
       WHERE m.role = 'assistant' AND m.superseded_at IS NULL AND m.kind != 'tool' AND m.id > e.last_id
       GROUP BY m.conversation_id`,
    ).all(...args) as Array<{ conversation_id: string; n: number }>;
    for (const row of rows) unreadByConversation.set(row.conversation_id, Number(row.n));
  }

  for (const id of ids) {
    const snap = out.get(id)!;
    snap.latest = latestByContact.get(id) ?? null;
    snap.conversations = (conversationsByContact.get(id) ?? []).map((conv) => {
      const unread = unreadByConversation.get(conv.id) ?? 0;
      snap.unread += unread;
      return {
        id: conv.id,
        channel: conv.channel,
        kind: conv.kind,
        title: conv.title,
        enabled: conv.enabled,
        leftAt: conv.left_at,
        createdAt: conv.created_at,
        latest: latestByConversation.get(conv.id) ?? null,
        unread,
      };
    });
  }
  return out;
}