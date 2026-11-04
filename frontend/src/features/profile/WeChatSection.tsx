import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, MessageCircle, Settings2 } from "lucide-react";
// qrcode 只在「生成绑定二维码」这一步用得到，不该进首屏 chunk。
import { wechatApi, type WeChatLink } from "../../api";
import Modal from "../../components/Modal";
import { ChannelBadge, ChannelNote, type ChannelTone } from "./ChannelKit";

type QrModal = {
  attemptId: string;
  dataUrl: string;
  status: "waiting" | "scanned" | "expired" | "error";
  error: string;
};

/** 联系人资料页的「微信连接」卡片：扫码绑定、状态、开关与解绑。 */
export function WeChatSection({ contactId, who = "这位联系人" }: { contactId: string; who?: string }): JSX.Element {
  const [link, setLink] = useState<WeChatLink | null>(null);
  const [qr, setQr] = useState<QrModal | null>(null);
  const [bindHint, setBindHint] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  /** 快照轮询的两道闸门：在途标记（别自己叠自己）+ 是否真的有过绑定。 */
  const busyRef = useRef(false);
  const boundRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (busyRef.current || document.hidden) return; // 上一发没回来就不叠加
    busyRef.current = true;
    try {
      const data = await wechatApi.fetchWeChatLink(contactId);
      if (alive.current) {
        setLink(data.link);
        boundRef.current = Boolean(data.link);
      }
    } catch { /* 快照失败不打扰编辑流程 */ } finally {
      busyRef.current = false;
    }
  }, [contactId]);

  useEffect(() => {
    setLink(null); setQr(null); setBindHint(""); setErr(""); setShowSettings(false);
    boundRef.current = false;   // 换联系人：上一个的绑定状态不能带过来
    void refresh();
    // 绑定后的会话凭证与错误来自微信侧事件，卡片开着时轻量刷新。
    // 三闸门：没绑定过不刷（没东西可刷）、页面切走不刷、上一发未回不叠加——
    // client 超时 10s 比轮询间隔长，慢网下定长轮询必然自己叠自己。
    const timer = setInterval(() => { if (boundRef.current) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const stopPoll = (): void => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
  };

  const startBind = async (): Promise<void> => {
    setErr(""); setBindHint("");
    setBusy(true);
    try {
      const data = await wechatApi.beginWeChatBind(contactId);
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(data.qrContent, { margin: 1, width: 224 });
      if (!alive.current) return;
      setQr({ attemptId: data.attemptId, dataUrl, status: "waiting", error: "" });
      stopPoll();
      // 绑定轮询同样要有在途标记：client 超时 10s 远长于 1.5s 间隔，慢网下最多能叠 6 发同请求，
      // 迟到的 "scanned" 还会把后一拍的 "confirmed" 盖回去（快照轮询上面就有这道闸门）。
      let bindBusy = false;
      pollTimer.current = setInterval(async () => {
        if (bindBusy) return;
        bindBusy = true;
        try {
          const st = await wechatApi.pollWeChatBind(contactId, data.attemptId);
          if (!alive.current) return;
          if (st.status === "confirmed") {
            stopPoll();
            setQr(null);
            if (st.link) setLink(st.link);
            setBindHint(`微信绑定成功。接下来从微信给${who}发一条消息；建立会话后机器人才能回复。`);
          } else if (st.status === "scanned") {
            setQr((prev) => (prev ? { ...prev, status: "scanned" } : prev));
          } else if (st.status === "expired" || st.status === "gone" || st.status === "error") {
            stopPoll();
            setQr((prev) => (prev ? { ...prev, status: st.status === "error" ? "error" : "expired", error: st.error || "二维码已过期，请重新生成" } : prev));
          }
        } catch (e: unknown) {
          if (!alive.current) return;
          stopPoll();
          setQr((prev) => (prev ? { ...prev, status: "error", error: e instanceof Error ? e.message : String(e) } : prev));
        } finally {
          bindBusy = false;
        }
      }, 1500);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const closeModal = (): void => { stopPoll(); setQr(null); };

  const patchFlags = async (patch: { enabled?: boolean; proactive?: boolean }): Promise<void> => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const data = await wechatApi.setWeChatFlags(contactId, patch);
      if (alive.current) setLink(data.link);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await wechatApi.disconnectWeChat(contactId);
      if (alive.current) { setLink(null); setConfirmOff(false); setShowSettings(false); setBindHint(""); }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /** 徽章语义：connected 在跑、attention 要人处理、paused/disabled 是停用（灰）。 */
  const badgeTone: ChannelTone =
    link === null ? "muted"
      : link.status === "connected" ? "ok"
        : link.status === "attention" ? "warn" : "muted";
  const badgeLabel = link === null ? "未连接" : wechatApi.WECHAT_STATUS_LABEL[link.status];

  return (
    <div className="card card-pad pf-model-card wx-card">
      <div className="wx-head">
        <span className="ch-channel-icon ch-channel-wx" aria-hidden="true"><MessageCircle size={17} strokeWidth={1.8} /></span>
        <div>
          <div className="pf-set-title">微信连接</div>
          <div className="pf-model-hint">
            从微信和{who}聊天，消息与上下文同步到本机同一段对话。
          </div>
        </div>
        <ChannelBadge tone={badgeTone} label={badgeLabel}
          title={link?.status === "attention" && link.lastError !== "" ? link.lastError : undefined} />
      </div>

      {!link && (
        /* 未连接空态：从前只有一枚孤零零的按钮，先讲清楚绑定能得到什么，再给唯一的下一步。 */
        <div className="ch-empty">
          <div className="ch-empty-points">
            <span>扫码后，先从微信发一条消息激活会话</span>
            <span>连接后可随时暂停或关闭主动发送</span>
          </div>
          <div className="wx-actions">
            <button type="button" className="primary sm" disabled={busy} onClick={() => { void startBind(); }}>
              {busy ? "正在生成…" : "扫码绑定微信"}
            </button>
          </div>
        </div>
      )}

      {link && !link.hasContext && bindHint === "" && (
        <ChannelNote tone="info">还差一步：请先在微信里给{who}发一条消息，建立会话后机器人才能回复。</ChannelNote>
      )}
      {link && link.status === "attention" && link.lastError !== "" && (
        <ChannelNote tone="error">{link.lastError}</ChannelNote>
      )}
      {bindHint !== "" && !link?.hasContext && <ChannelNote tone="success">{bindHint}</ChannelNote>}

      {err !== "" && <ChannelNote tone="error">{err}</ChannelNote>}

      {link && (
        <button type="button" className="qq-connection-manage" onClick={() => setShowSettings(true)}>
          <span className="qq-connection-manage-icon"><Settings2 size={16} strokeWidth={1.8} /></span>
          <span className="qq-connection-manage-copy">
            <strong>连接设置</strong>
            <small>
              {wechatApi.WECHAT_STATUS_LABEL[link.status]}
              {link.proactive ? " · 主动发送：允许" : " · 主动发送：关闭"}
            </small>
          </span>
          <ChevronRight size={16} strokeWidth={1.8} className="qq-connection-manage-arrow" />
        </button>
      )}

      {showSettings && link && (
        <Modal onClose={() => { if (!busy) setShowSettings(false); }} label="微信连接设置"
          className="qq-settings-modal" placement="center"
          head={<div className="qq-settings-head">
            <div>
              <div className="qq-settings-title">连接设置</div>
              <div className="qq-settings-sub">操作即时生效。</div>
            </div>
            <button type="button" className="qq-settings-close" disabled={busy}
              onClick={() => setShowSettings(false)}>关闭</button>
          </div>}>
          <div className="qq-settings-list">
            <div className="qq-setting-row">
              <span className="qq-setting-copy">
                <strong>{link.enabled ? "暂停连接" : "恢复连接"}</strong>
                <small>{link.enabled ? "保留绑定与聊天记录。" : "恢复后将重新收发。"}</small>
              </span>
              <button type="button" className="pf-ghost qq-setting-action" disabled={busy}
                onClick={() => { void patchFlags({ enabled: !link.enabled }); }}>
                {link.enabled ? "暂停" : "恢复"}
              </button>
            </div>
            <label className="qq-setting-row">
              <span className="qq-setting-copy">
                <strong>允许主动发送</strong>
                <small>已有微信会话时，提醒和主动关心会发到微信。</small>
              </span>
              <input type="checkbox" checked={link.proactive} disabled={busy}
                onChange={(e) => { void patchFlags({ proactive: e.target.checked }); }} />
            </label>
          </div>
          <div className="qq-settings-danger">
            <div className="qq-setting-copy">
              <strong>解除绑定</strong>
              <small>停止微信收发；聊天记录保留。</small>
            </div>
            <button type="button" className="pf-ghost wx-danger" disabled={busy}
              onClick={() => { setShowSettings(false); setConfirmOff(true); }}>
              解除绑定
            </button>
          </div>
        </Modal>
      )}

      {qr && (
        <Modal onClose={closeModal} label="微信扫码绑定" className="wx-modal"
          head={<div className="modal-title-row"><div className="modal-title">微信扫码绑定</div><button type="button" className="wx-close" onClick={closeModal}>关闭</button></div>}>
            {qr.status === "waiting" || qr.status === "scanned" ? (
              <>
                <img className="wx-qr" src={qr.dataUrl} alt="微信登录二维码" />
                <ChannelNote tone="info">
                  {qr.status === "scanned"
                    ? "已扫码，请在手机上确认登录。"
                    : "用微信「扫一扫」扫描下方二维码。二维码 8 分钟内有效。"}
                </ChannelNote>
              </>
            ) : (
              <>
                <ChannelNote tone="error">{qr.error}</ChannelNote>
                <div className="add-row">
                  <button type="button" className="primary" onClick={() => { void startBind(); }}>重新生成二维码</button>
                </div>
              </>
            )}
        </Modal>
      )}

      {confirmOff && (
        <Modal onClose={() => setConfirmOff(false)} label="解除微信绑定？" className="wx-modal">
          <div className="modal-title">解除微信绑定？</div>
          <div className="modal-sub">解绑后微信不再收发消息，对话记录保留。可重新扫码绑定。</div>
          <div className="add-row">
            <button type="button" onClick={() => setConfirmOff(false)}>取消</button>
            <button type="button" className="primary" disabled={busy} onClick={() => { void disconnect(); }}>确认解绑</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
