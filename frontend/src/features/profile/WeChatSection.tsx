import { useCallback, useEffect, useRef, useState } from "react";
// qrcode 只在「生成绑定二维码」这一步用得到，不该进首屏 chunk。
import { wechatApi, type WeChatLink } from "../../api";
import Modal from "../../components/Modal";

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
    setLink(null); setQr(null); setBindHint(""); setErr("");
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
            setBindHint(`绑定成功。请从微信先给${who}发一条消息，建立会话后${who}才能回话。`);
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
      if (alive.current) { setLink(null); setConfirmOff(false); setBindHint(""); }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="card card-pad pf-model-card wx-card">
      <div className="wx-head">
        <div>
          <div className="pf-set-title">微信连接</div>
          <div className="pf-model-hint">
            绑定后，{who}在对话里说出的每句话都会同步到这个联系人的微信；
            从微信发来的消息也会进入这段对话。
          </div>
        </div>
        {link && <span className={"wx-badge wx-badge-" + link.status}>{wechatApi.WECHAT_STATUS_LABEL[link.status]}</span>}
      </div>

      {!link && (
        <div className="wx-actions">
          <button type="button" className="pf-ghost" disabled={busy} onClick={() => { void startBind(); }}>
            {busy ? "正在生成…" : "生成微信二维码"}
          </button>
        </div>
      )}

      {link && !link.hasContext && (
        <div className="wx-note">还没有微信会话：请先在微信里给{who}发一条消息，建立会话后{who}才能回复。</div>
      )}
      {link && link.status === "attention" && link.lastError !== "" && (
        <div className="wx-error">{link.lastError}</div>
      )}
      {bindHint !== "" && <div className="wx-note">{bindHint}</div>}

      {link && (
        <div className="wx-controls">
          <label className="wx-check">
            <input
              type="checkbox"
              checked={link.enabled}
              disabled={busy}
              onChange={(e) => { void patchFlags({ enabled: e.target.checked }); }}
            />
            启用连接
          </label>
          <label className="wx-check" title={`开启后，${who}主动说的那句也会发到微信`}>
            <input
              type="checkbox"
              checked={link.proactive}
              disabled={busy}
              onChange={(e) => { void patchFlags({ proactive: e.target.checked }); }}
            />
            允许主动触达
          </label>
          <button type="button" className="pf-ghost wx-danger" disabled={busy} onClick={() => setConfirmOff(true)}>
            解除绑定
          </button>
        </div>
      )}
      {err !== "" && <div className="wx-error">{err}</div>}

      {qr && (
        <Modal onClose={closeModal} label="微信扫码绑定" className="wx-modal"
          head={<div className="modal-title-row"><div className="modal-title">微信扫码绑定</div><button type="button" className="wx-close" onClick={closeModal}>关闭</button></div>}>
            {qr.status === "waiting" || qr.status === "scanned" ? (
              <>
                <img className="wx-qr" src={qr.dataUrl} alt="微信登录二维码" />
                <div className="wx-note">
                  {qr.status === "scanned"
                    ? "已扫码，请在手机上确认登录。"
                    : "用微信「扫一扫」扫描下方二维码。二维码 8 分钟内有效。"}
                </div>
              </>
            ) : (
              <>
                <div className="wx-error">{qr.error}</div>
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
