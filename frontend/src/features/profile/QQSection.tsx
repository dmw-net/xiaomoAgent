import { useEffect, useRef, useState } from "react";
import { CircleMinus, PencilLine, Search, Trash2, UsersRound, X } from "lucide-react";
import { qqApi, type QQBindingView, type QQConversationView, type QQStatus } from "../../api";
import Modal from "../../components/Modal";

const GROUP_TITLE_MAX = 40;

/**
 * 联系人资料页的「QQ 连接」卡片。
 *
 * 每位联系人拥有独立的 QQ BotAccount，凭据与 openid 绑定都按联系人隔离。
 * 这张卡有三段状态机：
 *   未配置凭据 → 扫码拿（官方推荐这条），或手填 AppID/AppSecret 兜底
 *   已配置未绑定 → 开一个认领窗口，让用户在 QQ 里发「绑定」两个字
 *   已绑定 → 开关、被动回复窗口、解绑
 * 拿凭据这条**有**官方扫码；而"这位联系人对应哪个 QQ 用户"没有 QQ 号→openid 的接口，
 * openid 只能从一条入站消息里拿。所以那一步是让对方发两个字过来，不是我们查过去。两件事别混。
 */
export function QQSection({ contactId, who = "这位联系人" }: { contactId: string; who?: string }): JSX.Element {
  const [binding, setBinding] = useState<QQBindingView | null>(null);
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<QQStatus>("not-configured");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  /** 这位联系人的凭据拿到后表单收起；不给"换一台"的入口就等于配错一次只能去改库。 */
  const [editingCreds, setEditingCreds] = useState(false);
  /** 手填是兜底路径（扫码不可用时才展开），默认收起：两条路不该长得一样重要。 */
  const [manualOpen, setManualOpen] = useState(false);
  const [qr, setQr] = useState<{ taskId: string; dataUrl: string; status: "waiting" | "expired" | "error"; error: string } | null>(null);
  const [attempt, setAttempt] = useState<{ attemptId: string; keyword: string } | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState("");
  const [groupTitleDraft, setGroupTitleDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [toggleBusyId, setToggleBusyId] = useState("");
  const [clearTarget, setClearTarget] = useState<QQConversationView | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<QQConversationView | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  const [toggleProactiveBusyId, setToggleProactiveBusyId] = useState("");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const boundRef = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (qrTimer.current) clearInterval(qrTimer.current);
    };
  }, []);

  const refresh = async (): Promise<void> => {
    if (busyRef.current) return;   // 上一发没回来就不叠加（慢网下轮询会自己叠自己）
    busyRef.current = true;
    try {
      const data = await qqApi.fetchQQBinding(contactId);
      if (!alive.current) return;
      setBinding(data.binding);
      setConfigured(data.configured);
      setStatus(data.status);
      boundRef.current = data.binding !== null;
    } catch { /* 快照失败不打扰正在编辑的东西 */ } finally {
      busyRef.current = false;
    }
  };

  useEffect(() => {
    setBinding(null); setAttempt(null); setNote(""); setErr(""); setEditingCreds(false); setManualOpen(false);
    setEditingGroupId(""); setGroupTitleDraft(""); setRenameBusy(false); setToggleBusyId("");
    setToggleProactiveBusyId("");
    setClearTarget(null); setClearBusy(false); setRemoveTarget(null); setRemoveBusy(false); setGroupQuery("");
    stopQrPoll(); setQr(null);   // 换联系人：上一位没扫完的码不该继续在后台轮
    boundRef.current = false;   // 换联系人：上一位的绑定状态不能带过来
    void refresh();
    // 网关的错误与被动窗口都是这边之外在变的：开着卡片时轻量刷一下。
    // 三道闸门与微信那张一致——没绑过不刷、页面切走不刷、上一发未回不叠加。
    const timer = setInterval(() => { if (boundRef.current && !document.hidden) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [contactId]);

  const stopPoll = (): void => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
  };

  const saveCredentials = async (): Promise<void> => {
    setErr(""); setNote(""); setBusy(true);
    try {
      await qqApi.saveQQCredentials(contactId, { appId, clientSecret: secret, enabled: true });
      if (!alive.current) return;
      setSecret("");
      setNote("凭据已保存。接下来点「去绑定」，然后在 QQ 里给机器人发「绑定」两个字就行。");
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const stopQrPoll = (): void => {
    if (qrTimer.current) { clearInterval(qrTimer.current); qrTimer.current = null; }
  };

  /**
   * 扫码拿凭据：二维码内容是 q.qq.com 的一个链接，手机 QQ 扫它。
   * 服务端每两秒轮一次绑定结果，成功时**它自己**把 AppID/AppSecret 存下并连上网关——
   * 密钥与那把 AES 钥匙都不经过浏览器，所以这里只拿得到"成了"和脱敏后的 AppID。
   */
  const startQr = async (): Promise<void> => {
    setErr(""); setNote(""); setBusy(true);
    try {
      const data = await qqApi.beginQQCredentialQr(contactId);
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(data.qrContent, { margin: 1, width: 224 });
      if (!alive.current) return;
      setQr({ taskId: data.taskId, dataUrl, status: "waiting", error: "" });
      stopQrPoll();
      let innerBusy = false;
      qrTimer.current = setInterval(async () => {
        if (innerBusy) return;
        innerBusy = true;
        try {
          const st = await qqApi.pollQQCredentialQr(contactId, data.taskId);
          if (!alive.current) return;
          if (st.status === "created") {
            stopQrPoll();
            setQr(null);
            setNote(`已连上机器人 ${st.appId ?? ""}。接下来点「去绑定」，然后在 QQ 里给机器人发「绑定」两个字就行。`);
            await refresh();
          } else if (st.status === "expired" || st.status === "gone") {
            stopQrPoll();
            setQr((prev) => (prev ? { ...prev, status: "expired", error: st.error || "二维码已过期，请重新扫" } : prev));
          }
        } catch (e: unknown) {
          if (!alive.current) return;
          stopQrPoll();
          setQr((prev) => (prev ? { ...prev, status: "error", error: e instanceof Error ? e.message : String(e) } : prev));
        } finally {
          innerBusy = false;
        }
      }, 2000);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const startBind = async (): Promise<void> => {
    setErr(""); setNote(""); setBusy(true);
    try {
      const data = await qqApi.beginQQBind(contactId);
      if (!alive.current) return;
      setAttempt({ attemptId: data.attemptId, keyword: data.keyword });
      stopPoll();
      let innerBusy = false;
      pollTimer.current = setInterval(async () => {
        if (innerBusy) return;
        innerBusy = true;
        try {
          const st = await qqApi.pollQQBind(contactId, data.attemptId);
          if (!alive.current) return;
          if (st.status === "bound") {
            stopPoll();
            setAttempt(null);
            if (st.binding) setBinding(st.binding);
            setNote(`绑定成功。${who}要回话还得等你先在 QQ 里发一条——官方只允许在收到消息后的一小时内被动回复。`);
          } else if (st.status === "gone") {
            stopPoll();
            setErr(st.error);
          }
        } catch (e: unknown) {
          if (!alive.current) return;
          stopPoll();
          setErr(e instanceof Error ? e.message : String(e));
        } finally {
          innerBusy = false;
        }
      }, 2000);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const patchFlags = async (patch: { enabled?: boolean; proactive?: boolean }): Promise<void> => {
    if (busy || binding === null) return;
    setBusy(true); setErr("");
    try {
      const data = await qqApi.setQQFlags(contactId, patch);
      if (alive.current) setBinding(data.binding);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const openGroup = (conv: QQConversationView): void => {
    window.dispatchEvent(new CustomEvent("xiaomo:open-conversation", {
      detail: { contactId, conversationId: conv.id, title: conv.title, readOnly: true },
    }));
  };

  const toggleGroupEnabled = async (conv: QQConversationView): Promise<void> => {
    if (toggleBusyId !== "" || conv.leftAt !== null) return;
    const next = !conv.enabled;
    setToggleBusyId(conv.id); setErr("");
    setBinding((prev) => prev === null ? prev : {
      ...prev,
      conversations: prev.conversations.map((item) => item.id === conv.id ? { ...item, enabled: next } : item),
    });
    try {
      await qqApi.setQQConversationEnabled(contactId, conv.id, next);
    } catch (e: unknown) {
      if (alive.current) {
        setBinding((prev) => prev === null ? prev : {
          ...prev,
          conversations: prev.conversations.map((item) => item.id === conv.id ? { ...item, enabled: conv.enabled } : item),
        });
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (alive.current) setToggleBusyId("");
    }
  };

  const toggleGroupProactive = async (conv: QQConversationView): Promise<void> => {
    if (toggleProactiveBusyId !== "" || conv.leftAt !== null) return;
    const next = !conv.groupProactive;
    setToggleProactiveBusyId(conv.id); setErr("");
    // 乐观更新
    setBinding((prev) => prev === null ? prev : {
      ...prev,
      conversations: prev.conversations.map((item) => item.id === conv.id ? { ...item, groupProactive: next } : item),
    });
    try {
      await qqApi.setQQConversationGroupProactive(contactId, conv.id, next);
    } catch (e: unknown) {
      if (alive.current) {
        setBinding((prev) => prev === null ? prev : {
          ...prev,
          conversations: prev.conversations.map((item) => item.id === conv.id ? { ...item, groupProactive: conv.groupProactive } : item),
        });
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (alive.current) setToggleProactiveBusyId("");
    }
  };

  const clearGroupHistory = async (): Promise<void> => {
    if (clearTarget === null || clearBusy) return;
    const target = clearTarget;
    setClearBusy(true); setErr("");
    try {
      const data = await qqApi.clearQQConversationHistory(contactId, target.id);
      if (!alive.current) return;
      setBinding((prev) => prev === null ? prev : {
        ...prev,
        conversations: prev.conversations.map((item) => item.id === target.id ? { ...item, messageCount: 0 } : item),
      });
      setNote(`已清除 ${data.messages} 条消息、${data.memories} 条群记忆${data.media > 0 ? `，并回收 ${data.media} 个附件` : ""}。`);
      setClearTarget(null);
    } catch (e: unknown) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setClearBusy(false);
    }
  };

  const removeGroupConversation = async (): Promise<void> => {
    if (removeTarget === null || removeBusy) return;
    const target = removeTarget;
    setRemoveBusy(true); setErr("");
    try {
      const data = await qqApi.removeQQConversation(contactId, target.id);
      if (!alive.current) return;
      setBinding((prev) => prev === null ? prev : {
        ...prev,
        conversations: prev.conversations.filter((item) => item.id !== target.id),
      });
      setNote(`已移除「${target.title}」${data.messages > 0 ? `，并清除 ${data.messages} 条消息` : ""}。`);
      setRemoveTarget(null);
      window.dispatchEvent(new CustomEvent("xiaomo:conversation-removed", {
        detail: { contactId, conversationId: target.id },
      }));
    } catch (e: unknown) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setRemoveBusy(false);
    }
  };

  const startRename = (conv: QQConversationView): void => {
    setErr(""); setEditingGroupId(conv.id); setGroupTitleDraft(conv.title);
  };

  const saveGroupTitle = async (conv: QQConversationView, title: string | null): Promise<void> => {
    if (renameBusy) return;
    setRenameBusy(true); setErr("");
    try {
      const data = await qqApi.renameQQConversation(contactId, conv.id, title);
      if (!alive.current) return;
      setBinding((prev) => prev === null ? prev : {
        ...prev,
        conversations: prev.conversations.map((item) => item.id === conv.id ? { ...item, ...data.conversation } : item),
      });
      setEditingGroupId(""); setGroupTitleDraft("");
    } catch (e: unknown) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setRenameBusy(false);
    }
  };

  // 已离群群沉底；仅在群内的群按最近活跃排序。手动暂停不会让行跳走。
  const groupConversations = [...(binding?.conversations ?? [])].sort((a, b) => {
    if ((a.leftAt !== null) !== (b.leftAt !== null)) return a.leftAt !== null ? 1 : -1;
    const byTime = new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    return Number.isFinite(byTime) && byTime !== 0 ? byTime : a.title.localeCompare(b.title, "zh-CN");
  });
  const normalizedGroupQuery = groupQuery.trim().toLocaleLowerCase();
  const visibleGroups = normalizedGroupQuery === ""
    ? groupConversations
    : groupConversations.filter((conv) => conv.title.toLocaleLowerCase().includes(normalizedGroupQuery));
  const listeningGroups = groupConversations.filter((conv) => conv.enabled && conv.leftAt === null).length;
  const leftGroups = groupConversations.filter((conv) => conv.leftAt !== null).length;

  const disconnect = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await qqApi.disconnectQQ(contactId);
      if (alive.current) { setBinding(null); setConfirmOff(false); setNote(""); }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="card card-pad pf-model-card wx-card qq-card">
      <div className="wx-head">
        <div>
          <div className="pf-set-title">QQ 连接</div>
          <div className="pf-model-hint">
            接官方 QQ 机器人（开放平台）。QQ 私聊会并入联系人主私聊，和应用、微信保持同一段上下文；
            每个 QQ 群则单独隔离。只送文字：画好的图仍在这个应用里看。
          </div>
        </div>
        {binding && <span className={"wx-badge wx-badge-" + binding.status}>{qqApi.QQ_STATUS_LABEL[binding.status]}</span>}
        {/* 没绑定时只看这位自己的账号状态，不借别的联系人的网关绿灯。 */}
        {!binding && (
          <span className={"wx-badge " + (configured ? "wx-badge-unbound" : "wx-badge-not-configured")}>
            {configured ? "未绑定" : "未配置"}
          </span>
        )}
      </div>

      {/* ① 凭据：每位联系人一份，拿到一次就收起。扫码是官方推荐路径，手填留作兜底。 */}
      {(!configured || editingCreds) && (
        <div className="qq-creds">
          <div className="hint">
            用手机 QQ 扫一次就能把机器人建好、凭据自动填进来，不用去开放平台手抄。
            这份凭据只属于当前联系人；要接入另一位联系人，就为他单独创建一个 QQ 机器人。
            机器人要在平台侧<b>发布</b>之后才连得上正式环境，没发布会停在沙箱（连不上时原因写在下面）。
          </div>
          <div className="wx-actions">
            <button type="button" className="primary sm" disabled={busy} onClick={() => { void startQr(); }}>
              {busy ? "正在生成…" : "扫码创建机器人"}
            </button>
            {!manualOpen && (
              <button type="button" className="pf-ghost" disabled={busy} onClick={() => setManualOpen(true)}>
                我在平台已经有了，手填 AppID
              </button>
            )}
            {configured && (
              <button type="button" className="pf-ghost" disabled={busy} onClick={() => setEditingCreds(false)}>先不改</button>
            )}
          </div>
          {manualOpen && (
            <>
              <label>AppID
                <input value={appId} maxLength={40} placeholder="如 1021123456789"
                  onChange={(e) => setAppId(e.target.value.replace(/[^\d]/g, ""))} />
              </label>
              <label>AppSecret
                <input type="password" value={secret} maxLength={200} placeholder="保存后不再显示，要换再填一次"
                  autoComplete="new-password" onChange={(e) => setSecret(e.target.value)} />
              </label>
              <div className="wx-actions">
                <button type="button" className="pf-ghost" disabled={busy || appId.trim() === "" || secret.trim() === ""}
                  onClick={() => { void saveCredentials(); }}>
                  {busy ? "保存中…" : "保存并启用"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ② 已配置但这位联系人还没绑：开认领窗口。凭据已配好时留一个"换一台机器人"的入口。 */}
      {configured && !binding && !attempt && (
        <div className="wx-actions">
          <button type="button" className="pf-ghost" disabled={busy} onClick={() => { void startBind(); }}>
            {busy ? "正在开启…" : "去绑定"}
          </button>
          <span className="hint">
            {status === "connected" ? "机器人那头已经连上了，只差这位没绑定。点了之后在 QQ 里给机器人发「绑定」两个字（10 分钟内有效）。"
              : status === "connecting" ? "机器人还在连。连上之后点「去绑定」，再在 QQ 里发「绑定」两个字。"
              : "点了之后在 QQ 里给机器人发「绑定」两个字，机器人就接上这位联系人（10 分钟内有效）。"}
          </span>
          {!editingCreds && (
            <button type="button" className="pf-ghost" disabled={busy} onClick={() => setEditingCreds(true)}>换机器人凭据</button>
          )}
        </div>
      )}
      {configured && binding && !editingCreds && (
        <div className="wx-actions">
          <button type="button" className="pf-ghost" disabled={busy} onClick={() => setEditingCreds(true)}>换机器人凭据</button>
        </div>
      )}

      {attempt && (
        <div className="qq-code-row">
          <span className="hint">在 QQ 里发这两个字</span>
          <code className="qq-code" id="qq-bind-code">{attempt.keyword}</code>
          <button type="button" className="pf-ghost" onClick={() => { stopPoll(); setAttempt(null); }}>取消</button>
        </div>
      )}
      {attempt && (
        <div className="wx-note">正在等你发过去。发完这页自己就会认出来，不用刷新。</div>
      )}

      {note !== "" && <div className="wx-note">{note}</div>}
      {binding && !binding.hasReplyWindow && (
        <div className="wx-note">
          还没有可回复的窗口：请先在 QQ 里给{who}发一条消息。官方只允许在收到消息后的一小时内被动回复，
          超窗的句子要靠「消息能力」权限，没申请到就发不出去（发不出去会显示在下面）。
        </div>
      )}
      {binding && binding.status === "attention" && binding.lastError !== "" && (
        <div className="wx-error">{binding.lastError}</div>
      )}

      {binding && groupConversations.length > 0 && (
        <div className="qq-conv-list">
          <div className="qq-conv-list-head">
            <span className="qq-conv-list-title">
              <UsersRound size={14} strokeWidth={1.9} />
              QQ 群 <strong>{groupConversations.length}</strong>
            </span>
            <span className="qq-conv-list-status">
              {listeningGroups} 个收件中{leftGroups > 0 ? ` · ${leftGroups} 已离群` : ""}
            </span>
          </div>
          {groupConversations.length > 4 && (
            <div className="qq-conv-search">
              <Search size={14} strokeWidth={2} />
              <input value={groupQuery} placeholder="搜索群名" aria-label="搜索 QQ 群"
                onChange={(e) => setGroupQuery(e.target.value)} />
              {groupQuery !== "" && (
                <button type="button" aria-label="清除群名搜索" title="清除搜索" onClick={() => setGroupQuery("")}>
                  <X size={14} strokeWidth={2} />
                </button>
              )}
            </div>
          )}
          <div className={"qq-conv-scroll" + (groupConversations.length > 4 ? " bounded" : "")}>
          {visibleGroups.map((conv) => editingGroupId === conv.id ? (
            <form key={conv.id} className="qq-conv-rename"
              onSubmit={(e) => { e.preventDefault(); void saveGroupTitle(conv, groupTitleDraft); }}
              onKeyDown={(e) => { if (e.key === "Escape" && !renameBusy) setEditingGroupId(""); }}>
              <label className="qq-conv-rename-field">
                <span>群名称</span>
                <input value={groupTitleDraft} maxLength={GROUP_TITLE_MAX} autoFocus
                  placeholder="例如：周末放映室"
                  onChange={(e) => setGroupTitleDraft(e.target.value)} />
              </label>
              <div className="qq-conv-rename-foot">
                <span>{conv.titleSource === "custom" ? "当前为自定义名称；平台改名不会覆盖它" : "保存后会固定为你设置的名称"}</span>
                <div className="qq-conv-rename-actions">
                  {conv.titleSource === "custom" && (
                    <button type="button" className="qq-conv-reset" disabled={renameBusy}
                      onClick={() => { void saveGroupTitle(conv, null); }}>恢复自动</button>
                  )}
                  <button type="button" className="qq-conv-cancel" disabled={renameBusy}
                    onClick={() => setEditingGroupId("")}>取消</button>
                  <button type="submit" className="qq-conv-save"
                    disabled={renameBusy || groupTitleDraft.trim() === ""}>
                    {renameBusy ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div key={conv.id} className="qq-conv-row">
              <div className="qq-conv-main">
                <div className="qq-conv-title-row">
                  <button type="button" className="qq-conv-open" aria-label={`打开群会话 ${conv.title}`}
                    onClick={() => openGroup(conv)}>
                    <span className="qq-conv-title">{conv.title}</span>
                  </button>
                  <button type="button" className="qq-conv-edit-icon" aria-label={`重命名 ${conv.title}`}
                    title="重命名群" onClick={() => startRename(conv)}>
                    <PencilLine size={13} strokeWidth={1.9} />
                  </button>
                </div>
                <div className="qq-conv-meta-row">
                  <span className="qq-conv-meta">
                    {conv.leftAt !== null
                      ? conv.messageCount > 0 ? "已离群 · 仅保留历史" : "已离群 · 历史已清除"
                      : `${conv.titleSource === "custom" ? "自定义名称" : "平台群名"} · 群聊`}
                  </span>
                  {conv.leftAt !== null && conv.messageCount > 0 && (
                    <button type="button" className="qq-conv-clear" title="清除该群全部历史"
                      onClick={() => { setErr(""); setClearTarget(conv); }}>
                      <Trash2 size={11} strokeWidth={1.9} />清除历史
                    </button>
                  )}
                  {conv.leftAt !== null && (
                    <button type="button" className="qq-conv-remove" title="从群聊列表彻底移除"
                      onClick={() => { setErr(""); setRemoveTarget(conv); }}>
                      <CircleMinus size={11} strokeWidth={1.9} />移除群聊
                    </button>
                  )}
                  {conv.leftAt === null && (
                    <label className="qq-conv-proactive" title="开启后，主动消息（如定期关心、到点提醒）会同时推送到该群。需先在手机 QQ 群设置里打开「机器人主动在群内发言」。">
                      <input type="checkbox" checked={conv.groupProactive} disabled={toggleBusyId !== ""}
                        onChange={() => { void toggleGroupProactive(conv); }} />
                      <span>群主动消息</span>
                    </label>
                  )}
                </div>
              </div>
              <button type="button" role="switch" aria-checked={conv.enabled && conv.leftAt === null}
                aria-label={`${conv.title}群消息接收`}
                title={conv.leftAt !== null ? "机器人已被移出群聊或群已解散，仅保留历史" : conv.enabled ? "关闭群消息接收" : "开启群消息接收"}
                className={"qq-conv-switch " + (conv.leftAt !== null ? "left" : conv.enabled ? "on" : "off")}
                disabled={toggleBusyId === conv.id || conv.leftAt !== null}
                onClick={() => { void toggleGroupEnabled(conv); }}>
                <span className="qq-conv-switch-label">
                  {conv.leftAt !== null ? "已离群" : conv.enabled ? "收件中" : "已停用"}
                </span>
                <span className="qq-conv-switch-track" aria-hidden="true">
                  <span className="qq-conv-switch-thumb" />
                </span>
              </button>
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <div className="qq-conv-empty">没有找到匹配的群名</div>
          )}
          </div>
        </div>
      )}

      {binding && (
        <div className="wx-controls">
          <label className="wx-check">
            <input type="checkbox" checked={binding.enabled} disabled={busy}
              onChange={(e) => { void patchFlags({ enabled: e.target.checked }); }} />
            启用连接
          </label>
          <label className="wx-check" title={`开启后，${who}主动说的那句也会发到 QQ（需要平台的「消息能力」权限）`}>
            <input type="checkbox" checked={binding.proactive} disabled={busy}
              onChange={(e) => { void patchFlags({ proactive: e.target.checked }); }} />
            允许主动触达
          </label>
          <button type="button" className="pf-ghost wx-danger" disabled={busy} onClick={() => setConfirmOff(true)}>
            解除绑定
          </button>
        </div>
      )}
      {err !== "" && <div className="wx-error">{err}</div>}

      {clearTarget !== null && (
        <Modal onClose={() => { if (!clearBusy) setClearTarget(null); }} label="清除群聊历史"
          className="qq-clear-modal" placement="center">
          <div className="qq-clear-title">清除群聊历史？</div>
          <div className="qq-clear-copy">
            将永久删除「{clearTarget.title}」的 {clearTarget.messageCount} 条消息、处理上下文和群级记忆，
            并回收相关附件。联系人、其他群，以及已经提升为联系人全局记忆的内容不会受影响。
          </div>
          <div className="qq-clear-actions">
            <button type="button" className="pf-ghost" disabled={clearBusy}
              onClick={() => setClearTarget(null)}>取消</button>
            <button type="button" className="qq-clear-confirm" disabled={clearBusy}
              onClick={() => { void clearGroupHistory(); }}>
              {clearBusy ? "清除中…" : "确认清除"}
            </button>
          </div>
        </Modal>
      )}

      {removeTarget !== null && (
        <Modal onClose={() => { if (!removeBusy) setRemoveTarget(null); }} label="移除群聊"
          className="qq-clear-modal" placement="center">
          <div className="qq-clear-title">移除群聊？</div>
          <div className="qq-clear-copy">
            将从列表移除「{removeTarget.title}」
            {removeTarget.messageCount > 0 ? `，并永久删除其中的 ${removeTarget.messageCount} 条消息、处理上下文和群级记忆` : ""}。
            此操作不可恢复；之后再入群会建立新会话，不会继承这段历史。
          </div>
          <div className="qq-clear-actions">
            <button type="button" className="pf-ghost" disabled={removeBusy}
              onClick={() => setRemoveTarget(null)}>取消</button>
            <button type="button" className="qq-clear-confirm" disabled={removeBusy}
              onClick={() => { void removeGroupConversation(); }}>
              {removeBusy ? "移除中…" : "确认移除"}
            </button>
          </div>
        </Modal>
      )}

      {qr && (
        <Modal onClose={() => { stopQrPoll(); setQr(null); }} label="扫码创建 QQ 机器人" className="wx-modal"
          head={<div className="modal-title-row"><div className="modal-title">扫码创建 QQ 机器人</div>
            <button type="button" className="wx-close" onClick={() => { stopQrPoll(); setQr(null); }}>关闭</button></div>}>
          {qr.status === "waiting" ? (
            <>
              <img className="wx-qr" src={qr.dataUrl} alt="用手机 QQ 扫描的二维码" />
              <div className="wx-note">手机 QQ 扫这个码。扫完自动接着往下走，不用回来填什么。</div>
            </>
          ) : (
            <>
              <div className="wx-error">{qr.error}</div>
              <div className="add-row">
                <button type="button" className="primary" onClick={() => { void startQr(); }}>重新生成二维码</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {confirmOff && (
        <Modal onClose={() => setConfirmOff(false)} label="解除 QQ 绑定？" className="wx-modal">
          <div className="modal-title">解除 QQ 绑定？</div>
          <div className="modal-sub">解绑后这位联系人不再收发 QQ 消息，对话记录保留。重新点「去绑定」就能接回来。</div>
          <div className="add-row">
            <button type="button" onClick={() => setConfirmOff(false)}>取消</button>
            <button type="button" className="primary" disabled={busy} onClick={() => { void disconnect(); }}>确认解绑</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
