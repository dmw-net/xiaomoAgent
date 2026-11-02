// 会话隔离：一个联系人有一主多群的上下文。
//
// 应用内、微信与 QQ 私聊共享同一个 primary Conversation（`local-<contact_id>`）；
// 每个 QQ 群各自一段 Conversation。contact_id 仍是人设/记忆主体，群消息上下文、
// 摘要和会话级记忆必须带 conversation_id。

import { randomUUID } from "node:crypto";
import { db, q, withTx } from "./db.ts";
import { ensureConversationReadCursor, mergeConversationReadCursors, removeConversationReadCursor, resetConversationReadCursor, seedConversationReadBaselines } from "./contacts.ts";
import { releaseMediaFiles } from "./media.ts";

export type ConversationKind = "private" | "group";
export type ConversationChannel = "web" | "wechat" | "qq";
export type ConversationTitleSource = "auto" | "custom";
export const MAX_CONVERSATION_TITLE_LENGTH = 40;

export type Conversation = {
  id: string;
  contact_id: string;
  channel: ConversationChannel;
  kind: ConversationKind;
  external_id: string;
  account_id: string;
  title: string;
  title_source: ConversationTitleSource;
  auto_title: string;
  left_at: number | null;
  enabled: boolean;
  /** 群级主动消息开关；仅对 kind="group" 且 channel="qq" 有意义，对应 QQ 侧"机器人主动在群内发言"权限。 */
  group_proactive: boolean;
  summary: string;
  summary_updated_at: number | null;
  summary_upto: number | null;
  last_message_at: number | null;
  created_at: number;
};

export function localConversationId(contactId: string): string {
  return `local-${contactId}`;
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id ?? ""),
    contact_id: String(row.contact_id ?? ""),
    channel: String(row.channel ?? "web") as ConversationChannel,
    kind: String(row.kind ?? "private") as ConversationKind,
    external_id: String(row.external_id ?? ""),
    account_id: String(row.account_id ?? ""),
    title: String(row.title ?? ""),
    title_source: row.title_source === "custom" ? "custom" : "auto",
    auto_title: String(row.auto_title ?? ""),
    left_at: row.left_at === null || row.left_at === undefined ? null : Number(row.left_at),
    enabled: Number(row.enabled ?? 1) !== 0,
    group_proactive: Number(row.group_proactive ?? 0) !== 0,
    summary: String(row.summary ?? ""),
    summary_updated_at: row.summary_updated_at === null || row.summary_updated_at === undefined ? null : Number(row.summary_updated_at),
    summary_upto: row.summary_upto === null || row.summary_upto === undefined ? null : Number(row.summary_upto),
    last_message_at: row.last_message_at === null || row.last_message_at === undefined ? null : Number(row.last_message_at),
    created_at: Number(row.created_at ?? 0),
  };
}

export function getConversation(id: string): Conversation | null {
  if (id === "") return null;
  const row = q("SELECT * FROM conversations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToConversation(row);
}

/**
 * 找可以"过户"的旧群会话：同一个物理群在官方（openid，非纯数字）与 OneBot（群号，纯数字）
 * 两个 ID 命名空间下长得不一样，渠道来回切会各留一条孤儿。incomingNumeric 表示来的是
 * 哪个命名空间：true（OneBot 群号）就找官方遗留的 openid 会话，false 反之——对称过户，
 * 来回切都不裂。只有恰好一个候选时才返回，多个候选宁可新建也不能张冠李戴。
 */
export function findAdoptableGroupConversation(contactId: string, incomingNumeric: boolean): Conversation | null {
  const rows = q(
    `SELECT * FROM conversations
     WHERE contact_id = ? AND channel = 'qq' AND kind = 'group' AND enabled = 1`,
  ).all(contactId) as Array<Record<string, unknown>>;
  const candidates = rows
    .map(rowToConversation)
    .filter((c) => c.external_id !== "" && (/^\d+$/.test(c.external_id) !== incomingNumeric));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** 把旧群会话过户成新渠道的群：换 external_id 与归属账号（ID 命名空间换了），历史与记忆原地保留。 */
export function adoptGroupConversation(conversationId: string, newExternalId: string, accountId = ""): void {
  q("UPDATE conversations SET external_id = ?, account_id = ? WHERE id = ?")
    .run(newExternalId, accountId, conversationId);
}

export function ensureLocalConversation(contactId: string, title = ""): Conversation {
  const id = localConversationId(contactId);
  const fallbackTitle = title || (q("SELECT name FROM contacts WHERE id = ?").get(contactId) as { name?: string } | undefined)?.name || "本机对话";
  const inserted = q(
    `INSERT OR IGNORE INTO conversations
       (id, contact_id, channel, kind, external_id, account_id, title, enabled, created_at)
     VALUES (?, ?, 'web', 'private', 'local', '', ?, 1, ?)`,
  ).run(id, contactId, fallbackTitle, Date.now());
  if (Number(inserted.changes) > 0) ensureConversationReadCursor(id);
  // 用户改过联系人名时只补空标题，不覆盖手动改过的会话名。
  q("UPDATE conversations SET title = ? WHERE id = ? AND title = ''").run(fallbackTitle, id);
  return getConversation(id)!;
}

export function ensureConversation(input: {
  id?: string;
  contactId: string;
  channel: ConversationChannel;
  kind: ConversationKind;
  externalId: string;
  accountId?: string;
  title?: string;
  enabled?: boolean;
}): Conversation {
  const accountId = input.accountId ?? "";
  const existing = q(
    `SELECT * FROM conversations
     WHERE contact_id = ? AND channel = ? AND kind = ? AND external_id = ? AND account_id = ?`,
  ).get(input.contactId, input.channel, input.kind, input.externalId, accountId) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    const conv = rowToConversation(existing);
    const platformTitle = input.title?.trim() ?? "";
    if (platformTitle !== "") {
      // 平台名持续留在 auto_title，自定义名则只更新后备值、不改用户看到的标题。
      if (conv.title_source === "custom") {
        q("UPDATE conversations SET auto_title = ? WHERE id = ?").run(platformTitle, conv.id);
        conv.auto_title = platformTitle;
      } else {
        q("UPDATE conversations SET title = ?, auto_title = ?, title_source = 'auto' WHERE id = ?")
          .run(platformTitle, platformTitle, conv.id);
        conv.title = platformTitle;
        conv.auto_title = platformTitle;
        conv.title_source = "auto";
      }
    }
    return conv;
  }
  const id = input.id || (input.channel === "web" && input.kind === "private"
    ? localConversationId(input.contactId)
    : `conv-${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  const platformTitle = input.title?.trim() ?? "";
  const initialTitle = platformTitle || (input.kind === "group" ? "QQ 群" : "QQ 私聊");
  q(
    `INSERT INTO conversations
       (id, contact_id, channel, kind, external_id, account_id, title, title_source, auto_title, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
  ).run(
    id,
    input.contactId,
    input.channel,
    input.kind,
    input.externalId,
    accountId,
    initialTitle,
    platformTitle,
    input.enabled === false ? 0 : 1,
    Date.now(),
  );
  ensureConversationReadCursor(id);
  return getConversation(id)!;
}

/** 把输入整理成单行显示名；空串由调用方决定是否允许。 */
export function normalizeConversationTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/**
 * 只允许改属于当前联系人的 QQ 群名。
 * null 表示恢复平台自动名；若平台从未给过名字，则退回“QQ 群”占位。
 */
export function renameQQGroupConversation(
  id: string,
  contactId: string,
  title: string | null,
): Conversation | null {
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") return null;
  if (title === null) {
    const fallback = conv.auto_title || "QQ 群";
    q("UPDATE conversations SET title = ?, title_source = 'auto' WHERE id = ?").run(fallback, id);
  } else {
    const normalized = normalizeConversationTitle(title);
    if (normalized === "" || normalized.length > MAX_CONVERSATION_TITLE_LENGTH) return null;
    q("UPDATE conversations SET title = ?, title_source = 'custom' WHERE id = ?").run(normalized, id);
  }
  return getConversation(id);
}

/**
 * 把旧版本的个人 QQ/微信 Conversation 并入联系人主会话。
 *
 * 产品语义是「一对一私聊只有一段关系」：应用、微信和 QQ 私聊的消息、
 * 上下文、搜索与未读都应连续；只有 QQ 群因为参与者与上下文不同而独立。
 * 这里保留原消息 id 与时间，只改 conversation_id，因此不会重排历史。
 */
export function mergePrivateConversationsIntoLocal(): void {
  const rows = q(
    `SELECT id, contact_id FROM conversations
      WHERE kind = 'private' AND channel IN ('qq', 'wechat')`,
  ).all() as Array<{ id: string; contact_id: string }>;
  if (rows.length === 0) return;
  withTx(() => {
    for (const row of rows) {
      const local = ensureLocalConversation(row.contact_id);
      if (local.id === row.id) continue;
      q("UPDATE messages SET conversation_id = ? WHERE conversation_id = ?").run(local.id, row.id);
      q("UPDATE turns SET conversation_id = ? WHERE conversation_id = ?").run(local.id, row.id);
      q("UPDATE memory_events SET scope_conversation_id = ? WHERE scope_conversation_id = ?").run(local.id, row.id);
      q("UPDATE memory_events SET source_conversation_id = ? WHERE source_conversation_id = ?").run(local.id, row.id);
      const last = q("SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ?")
        .get(local.id) as { at: number | null } | undefined;
      q(`UPDATE conversations
        SET last_message_at = CASE
          WHEN ? > COALESCE(last_message_at, 0) THEN ? ELSE last_message_at END
        WHERE id = ?`).run(Number(last?.at ?? 0), Number(last?.at ?? 0), local.id);
      mergeConversationReadCursors(row.id, local.id);
      q("DELETE FROM conversations WHERE id = ?").run(row.id);
    }
  });
}

/** 启动迁移：每个联系人都有一段主会话，所有旧消息/轮次回填到它。 */
export function ensureDefaultConversations(): void {
  const contacts = q("SELECT id, name FROM contacts").all() as Array<{ id: string; name: string }>;
  for (const contact of contacts) ensureLocalConversation(contact.id, contact.name);
  db.exec(`
    UPDATE messages SET conversation_id = 'local-' || contact_id
      WHERE conversation_id IS NULL AND contact_id IS NOT NULL;
    UPDATE turns SET conversation_id = 'local-' || contact_id
      WHERE conversation_id IS NULL AND contact_id IS NOT NULL;
    UPDATE memory_events SET scope_kind = 'global'
      WHERE scope_kind IS NULL OR scope_kind = '';
    UPDATE memory_events SET source_conversation_id = 'local-' || contact_id
      WHERE source_conversation_id IS NULL AND contact_id IS NOT NULL;
  `);
  // 一对一通道先合流，再统一补一次已读水位，避免旧回复在升级后集体变红。
  mergePrivateConversationsIntoLocal();
  seedConversationReadBaselines();
  // member 这一层撤掉了（见 memory.ts 的 decideMemoryScope）：群里说的话对全群本就公开，
  // 归到群名下即可。subject_id / subject_name 原样留着当出处，不再参与任何读写。
  db.exec(`UPDATE memory_events SET scope_kind = 'conversation' WHERE scope_kind = 'member'`);
  // 群成员名册表是给那一层用的，层没了它就没有任何读它的人；它记的每个 id 与昵称
  // 本来就能从 messages 重算出来，所以不留一张没人用的表在库里误导后来人。
  db.exec("DROP TABLE IF EXISTS group_members");
}

export function listConversations(contactId: string): Conversation[] {
  ensureLocalConversation(contactId);
  const rows = q(
    `SELECT * FROM conversations WHERE contact_id = ?
     ORDER BY CASE WHEN channel = 'web' AND kind = 'private' THEN 0 ELSE 1 END,
              COALESCE(last_message_at, created_at) DESC`,
  ).all(contactId) as Array<Record<string, unknown>>;
  return rows.map(rowToConversation);
}
/**
 * 联系人列表的一次性批量会话查询。
 * 联系人列表每 10 秒重拉一次，逐个联系人调用 listConversations() 会退化成 N+1；
 * 这里先批量补齐本地主会话，再用一条查询取回全部会话。
 */
export function listConversationsForContacts(contactIds: string[]): Map<string, Conversation[]> {
  const ids = [...new Set(contactIds.filter((id) => id !== ""))];
  const out = new Map<string, Conversation[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;

  const marks = ids.map(() => "?").join(",");
  // 本地主会话缺失通常是新建联系人还没被列表打开过：批量补，不逐个 INSERT。
  const missing = q(
    `SELECT c.id FROM contacts c
     WHERE c.id IN (${marks})
       AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.id = 'local-' || c.id)`,
  ).all(...ids) as Array<{ id: string }>;
  if (missing.length > 0) {
    q(
      `INSERT OR IGNORE INTO conversations
         (id, contact_id, channel, kind, external_id, account_id, title, enabled, created_at)
       SELECT 'local-' || c.id, c.id, 'web', 'private', 'local', '', c.name, 1, ?
       FROM contacts c WHERE c.id IN (${marks})`,
    ).run(Date.now(), ...ids);
    for (const row of missing) ensureConversationReadCursor(localConversationId(row.id));
  }
  // 与 ensureLocalConversation 同一套补标题：只改空标题，不覆盖用户自定义名。
  q(
    `UPDATE conversations
     SET title = COALESCE((SELECT name FROM contacts WHERE contacts.id = conversations.contact_id), '本机对话')
     WHERE id IN (SELECT 'local-' || c.id FROM contacts c WHERE c.id IN (${marks}))
       AND title = ''`,
  ).run(...ids);

  const rows = q(
    `SELECT * FROM conversations WHERE contact_id IN (${marks})
     ORDER BY contact_id,
              CASE WHEN channel = 'web' AND kind = 'private' THEN 0 ELSE 1 END,
              COALESCE(last_message_at, created_at) DESC`,
  ).all(...ids) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const conv = rowToConversation(row);
    out.get(conv.contact_id)?.push(conv);
  }
  return out;
}

export function findConversation(input: {
  contactId: string;
  channel: ConversationChannel;
  kind: ConversationKind;
  externalId: string;
  accountId?: string;
}): Conversation | null {
  const row = q(
    `SELECT * FROM conversations
     WHERE contact_id = ? AND channel = ? AND kind = ? AND external_id = ? AND account_id = ?`,
  ).get(input.contactId, input.channel, input.kind, input.externalId, input.accountId ?? "") as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToConversation(row);
}

export function setConversationEnabled(id: string, enabled: boolean): boolean {
  return Number(q("UPDATE conversations SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes) > 0;
}

/**
 * 平台群成员关系变化。离群只停用收件并保留全部历史；重新入群时恢复，
 * 但若原本只是用户手动暂停，新增事件不应擅自打开。
 */
export function setConversationMembership(id: string, joined: boolean, at = Date.now()): Conversation | null {
  const conv = getConversation(id);
  if (conv === null) return null;
  if (joined) {
    const enabled = conv.left_at === null ? conv.enabled : true;
    q("UPDATE conversations SET left_at = NULL, enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  } else {
    q("UPDATE conversations SET left_at = COALESCE(left_at, ?), enabled = 0 WHERE id = ?").run(at, id);
  }
  return getConversation(id);
}

export type ClearedConversationHistory = {
  messages: number;
  turns: number;
  memories: number;
  media: number;
};

const MEDIA_REF_RE = /\/media\/([a-z0-9]{16}\.(?:png|jpg|webp|gif|mp4|webm|mp3|wav|m4a|ogg|opus|weba))/g;

function mediaUrlsFromAttachmentRows(rows: Array<{ attachments: string | null }>): string[] {
  const urls = new Set<string>();
  for (const row of rows) {
    for (const match of String(row.attachments ?? "").matchAll(MEDIA_REF_RE)) {
      if (match[1]) urls.add("/media/" + match[1]);
    }
  }
  return [...urls];
}

/**
 * 手动清除已离群 QQ 群的历史。会话外壳、标题、成员关系标记都保留，
 * 因此重新入群仍沿用同一个 Conversation；只删除群内消息、轮次、摘要与群级记忆。
 */
export function clearQQGroupHistory(id: string, contactId: string): ClearedConversationHistory | null {
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") return null;
  // 不再按 left_at 拦：清除历史对在收的群同样合法（清完继续收）；防手滑由入口确认框负责。

  const messageRows = q("SELECT attachments FROM messages WHERE conversation_id = ?")
    .all(id) as Array<{ attachments: string | null }>;
  const turnRows = q("SELECT attachments FROM turns WHERE conversation_id = ?")
    .all(id) as Array<{ attachments: string | null }>;
  const urls = [...new Set([...mediaUrlsFromAttachmentRows(messageRows), ...mediaUrlsFromAttachmentRows(turnRows)])];

  const cleared = withTx(() => {
    const messages = Number(q("DELETE FROM messages WHERE conversation_id = ?").run(id).changes);
    const turns = Number(q("DELETE FROM turns WHERE conversation_id = ?").run(id).changes);
    const memories = Number(q("DELETE FROM memory_events WHERE scope_conversation_id = ?").run(id).changes);
    // 被提升到联系人全局的记忆保留，但不再保留指向已清空群会话的来源。
    q("UPDATE memory_events SET source_conversation_id = NULL WHERE source_conversation_id = ?").run(id);
    q(`UPDATE conversations
      SET summary = '', summary_updated_at = NULL, summary_upto = NULL, last_message_at = NULL
      WHERE id = ?`).run(id);
    return { messages, turns, memories };
  });
  resetConversationReadCursor(id);
  releaseMediaFiles(urls);
  return { ...cleared, media: urls.length };
}

/** 从列表彻底移除群会话：先清历史，再删除会话外壳与已读游标。
 *  官方渠道的离群（left_at 非空）与 OneBot 的已停用（enabled=0，OneBot 没有离群事件，
 *  用户靠关「收件中」表达"不要了"）都可以移除；还在收的群必须先关收件再删，防手滑。 */
export function removeQQGroupConversation(id: string, contactId: string): ClearedConversationHistory | null {
  const conv = getConversation(id);
  if (conv === null || conv.contact_id !== contactId || conv.channel !== "qq" || conv.kind !== "group") return null;
  if (conv.left_at === null && conv.enabled) return null;
  const cleared = clearQQGroupHistory(id, contactId);
  if (cleared === null) return null;
  q("DELETE FROM conversations WHERE id = ?").run(id);
  removeConversationReadCursor(id);
  return cleared;
}

export function setConversationGroupProactive(id: string, groupProactive: boolean): boolean {
  return Number(q("UPDATE conversations SET group_proactive = ? WHERE id = ?").run(groupProactive ? 1 : 0, id).changes) > 0;
}

/** 列出该联系人下已开启群主动消息的 QQ 群会话（用于 proactive 投递）。 */
export function listGroupProactiveConversations(contactId: string): Array<Pick<Conversation, "id" | "external_id" | "account_id" | "title">> {
  const rows = q(
    `SELECT id, external_id, account_id, title FROM conversations
     WHERE contact_id = ? AND channel = 'qq' AND kind = 'group'
       AND enabled = 1 AND group_proactive = 1 AND left_at IS NULL`,
  ).all(contactId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    external_id: String(row.external_id ?? ""),
    account_id: String(row.account_id ?? ""),
    title: String(row.title ?? ""),
  }));
}

export type ProactiveCandidate = {
  id: string;
  kind: ConversationKind;
  title: string;
  /** 这段会话最近一次有动静的时刻；从没聊过为 null。 */
  activeAt: number | null;
};

/**
 * 主动消息的目标候选：主私聊 + 开了主动权限的 QQ 群，最近动静在前。
 * 「一条主动消息只说给一个地方听」的第一步——候选集本身就是"她有可能主动开口的地方"。
 */
export function listProactiveCandidates(contactId: string): ProactiveCandidate[] {
  const rows = q(
    `SELECT id, kind, title, last_message_at FROM conversations
     WHERE contact_id = ? AND enabled = 1 AND left_at IS NULL
       AND (kind = 'private' OR (channel = 'qq' AND group_proactive = 1))
     ORDER BY COALESCE(last_message_at, created_at) DESC, id ASC`,
  ).all(contactId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    kind: String(row.kind ?? "private") as ConversationKind,
    title: String(row.title ?? ""),
    activeAt:
      row.last_message_at === null || row.last_message_at === undefined ? null : Number(row.last_message_at),
  }));
}

export function touchConversation(id: string, at = Date.now()): void {
  q("UPDATE conversations SET last_message_at = ? WHERE id = ?").run(at, id);
}

export function updateConversationSummary(id: string, summary: string, upto?: number): void {
  q("UPDATE conversations SET summary = ?, summary_updated_at = ?, summary_upto = COALESCE(?, summary_upto) WHERE id = ?")
    .run(summary, Date.now(), upto ?? null, id);
}

export function deleteConversationsForContact(contactId: string): void {
  q("DELETE FROM conversations WHERE contact_id = ?").run(contactId);
}
