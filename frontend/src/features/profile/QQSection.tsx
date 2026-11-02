import { useEffect, useRef, useState } from "react";
import { Bot, Check, CircleMinus, Copy, PencilLine, Search, Trash2, UsersRound, X } from "lucide-react";
import { avatarApi, qqApi, type QQBindingView, type QQConversationView, type QQStatus } from "../../api";
import Modal from "../../components/Modal";
import EmoteCapability from "./EmoteCapability";
import { ChannelBadge, ChannelNote, ChannelSteps, type ChannelStep, type ChannelTone } from "./ChannelKit";

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
  /** 后端选型：official=官方 Bot（扫码/凭据），onebot=第三方协议端（填真实 QQ 号）。 */
  const [backend, setBackend] = useState<"official" | "onebot">("official");
  /** 渠道切换：后端当场热切（旧渠道 stopAll、新渠道 startAll），成功后卡片随渠道换形态。 */
  const [savedBackend, setSavedBackend] = useState<"official" | "onebot" | null>(null);
  const [backendBusy, setBackendBusy] = useState(false);
  const [backendNote, setBackendNote] = useState("");
  /** OneBot 模式：待填的真实 QQ 号。 */
  const [obQqNumber, setObQqNumber] = useState("");
  /** 主人的真实 QQ 号（可选）：群聊里把主人从群成员里认出来，不再见谁都叫主人。 */
  const [obOwnerQq, setObOwnerQq] = useState("");
  /** OneBot 绑定入口：协议端探测结果（登录账号/连通性），带头像地址与手动兜底开关。 */
  const [obStatus, setObStatus] = useState<qqApi.OneBotLoginInfo | null>(null);
  const [obAvatar, setObAvatar] = useState("");
  const [obManual, setObManual] = useState(false);
  const [obProbeTick, setProbeTick] = useState(0);
  /** 协议端连接面板：地址可就地改（热生效），不再逼用户去改配置文件。 */
  const [obAddr, setObAddr] = useState("");
  const [obWsAddr, setObWsAddr] = useState("");
  const [obAddrBusy, setObAddrBusy] = useState(false);
  const [obAddrNote, setObAddrNote] = useState("");
  /** 小茉托管的 NapCat：一键安装/启动/登录的状态源与动作入口。 */
  const [napcat, setNapcat] = useState<qqApi.NapcatStatus | null>(null);
  const [napcatBusy, setNapcatBusy] = useState<"install" | "start" | null>(null);
  const [napcatNote, setNapcatNote] = useState("");
  const [napcatQr, setNapcatQr] = useState("");
  /** 渠道切换确认框：切是全局且即时生效的，别让一次误触悄悄改了所有联系人的收发路径。 */
  const [confirmBackend, setConfirmBackend] = useState<"official" | "onebot" | null>(null);
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
  /** 绑定口令复制成功的瞬时反馈；两秒后自己落回复制图标。 */
  const [copied, setCopied] = useState(false);
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

  /** 渠道选型是进程级的；挂载时探一次：运行中的值 + 库里已保存的值。 */
  useEffect(() => {
    let cancelled = false;
    qqApi.fetchQQBackend().then((data) => {
      if (cancelled) return;
      setBackend(data.backend);
      setSavedBackend(data.saved);
    }).catch(() => { /* 拿不到就保持 official 默认态 */ });
    return () => { cancelled = true; };
  }, []);

  /** 切换接入渠道（全局）：后端当场热切，成功后刷新绑定态——两种渠道的凭据/绑定互不相通。 */
  const switchBackend = async (next: "official" | "onebot"): Promise<void> => {
    if (backendBusy || next === savedBackend) return;
    setBackendBusy(true); setBackendNote("");
    try {
      const r = await qqApi.setQQBackend(next);
      if (!alive.current) return;
      setSavedBackend(r.backend);
      setBackend(r.backend);
      setBackendNote("渠道已切换，即时生效");
      void refresh();
    } catch (e: unknown) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBackendBusy(false);
    }
  };

  /** 托管 NapCat 的状态轮询：只在 OneBot 渠道、且还没登录完成时转；登录成功即停。 */
  useEffect(() => {
    if (backend !== "onebot") return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const probeNapcat = async (): Promise<void> => {
      try {
        const s = await qqApi.fetchNapcatStatus();
        if (cancelled) return;
        setNapcat(s);
        setNapcatQr((prev) => (s.loggedIn ? "" : (s.qrUrl !== "" ? s.qrUrl : prev)));
        if (s.loggedIn && timer !== null) { clearInterval(timer); timer = null; }
      } catch { /* 状态拿不到就下一轮再说 */ }
    };
    void probeNapcat();
    timer = setInterval(() => { void probeNapcat(); }, 4000);
    return () => { cancelled = true; if (timer !== null) clearInterval(timer); };
  }, [backend]);

  /** 一键安装 / 一键启动：动作是长请求，期间锁按钮，结束把状态轮询立刻拉一把。 */
  const runNapcat = async (action: "install" | "start"): Promise<void> => {
    if (napcatBusy !== null) return;
    setNapcatBusy(action); setNapcatNote("");
    try {
      const r = await qqApi.napcatAction(action);
      if (!alive.current) return;
      if (!r.ok) setNapcatNote(r.error);
      else if (r.needsQr === true) setNapcatNote("NapCat 已启动，用手机 QQ 扫下面的二维码登录（下次启动自动登录，不用再扫）");
      else setNapcatNote(action === "install" ? "安装完成，正在启动…" : "NapCat 已就绪");
      setProbeTick((t) => t + 1);
    } catch (e: unknown) {
      setNapcatNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setNapcatBusy(null);
    }
  };

  /** 保存协议端地址并立刻重连探测：面板上的「保存并连接」。出站（HTTP）与收件（forward WS）一起存。 */
  const connectOneBot = async (): Promise<void> => {
    if (obAddrBusy) return;
    setObAddrBusy(true); setObAddrNote("");
    try {
      await qqApi.saveOneBotSettings({ httpBase: obAddr.trim(), wsUrl: obWsAddr.trim() });
      setObAddrNote("已保存，正在重连…");
      setObStatus(null);
      setProbeTick((t) => t + 1);
    } catch (e: unknown) {
      setObAddrNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setObAddrBusy(false);
    }
  };

  /** 托管 NapCat 二维码：拿登录链接渲染成图，首次登录让用户扫一下。 */
  const [napcatQrDataUrl, setNapcatQrDataUrl] = useState("");
  useEffect(() => {
    if (napcatQr === "") { setNapcatQrDataUrl(""); return; }
    let cancelled = false;
    import("qrcode").then(({ toDataURL }) => toDataURL(napcatQr, { margin: 1, width: 200 }))
      .then((url) => { if (!cancelled) setNapcatQrDataUrl(url); })
      .catch(() => { /* 渲染不出就摆链接 */ });
    return () => { cancelled = true; };
  }, [napcatQr]);

  /** 协议端连接面板（离线态共用，绑定与否都在这修）：
   *  setup = 这位联系人还没绑（首次安装引导）；repair = 已经绑过、协议端临时掉线（恢复语境）。
   *  两种语境必须不同：绑定态再给「绑定这位联系人」的步骤，人会以为绑定丢了。
   *  主路径是小茉托管的一键安装/启动/扫码——用户全程只点按钮、扫一次码；
   *  自备 NapCat 的手动地址连接收进兜底，别让两条路长得一样重要。 */
  const obConnectPanel = (mode: "setup" | "repair" = "setup"): JSX.Element => {
    const nc = napcat;
    const repair = mode === "repair";
    /** 一键托管流的步骤：装 → 启动登录 → 绑号/恢复。前两步的进度从托管状态实时读出来。 */
    const obSteps: ChannelStep[] = [
      { label: "安装 NapCat", state: nc !== null && nc.installed ? "done" : "current", hint: "小茉自动下载（约 20MB），装进数据目录" },
      {
        label: "启动并扫码登录",
        state: nc !== null && nc.loggedIn ? "done" : nc !== null && nc.installed && (nc.running || napcatBusy === "start") ? "current" : "todo",
        hint: nc !== null && nc.loggedIn ? `已登录：${nc.nickname}（${nc.uin}）` : "手机 QQ 扫一次码，之后自动登录",
      },
      repair
        ? { label: "恢复收发通道", state: nc !== null && nc.loggedIn ? "current" : "todo", hint: "通道一恢复，这位联系人的 QQ 消息自动接上" }
        : { label: "绑定这位联系人", state: nc !== null && nc.loggedIn ? "current" : "todo" },
    ];
    return (
      <div className="ob-connect">
        <div className="ob-connect-head">
          <span className="ob-connect-title">{repair ? "重新连接 NapCat" : "一键连接 NapCat"}</span>
          <span className="hint">{repair ? "这位联系人已绑定，协议端临时没连上；修好即恢复收发" : "小茉帮你装好、起好、配好，你只需点按钮、扫一次码"}</span>
        </div>
        {nc === null ? (
          <div className="hint">正在检查本机 NapCat…</div>
        ) : nc.loggedIn && nc.uin !== "" ? (
          <>
            <ChannelSteps steps={obSteps} label="NapCat 连接步骤" />
            {repair ? (
              <ChannelNote tone="warn">
                NapCat 显示已登录：{nc.nickname}（{nc.uin}），但小茉暂时连不上它的 HTTP 接口，收发不通。
                检查下面手动地址里的端口和 NapCat 网络配置是否对得上，或重启 NapCat。
              </ChannelNote>
            ) : (
              <ChannelNote tone="success">
                NapCat 已就绪：{nc.nickname}（{nc.uin}）已登录，收发通道都开着。绑定入口在下面。
              </ChannelNote>
            )}
          </>
        ) : (
          <>
            <ChannelSteps steps={obSteps} label="NapCat 连接步骤" />
            {!nc.installed ? (
              <div className="wx-actions">
                <button type="button" className="primary sm" disabled={napcatBusy !== null}
                  onClick={() => { void runNapcat("install"); }}>
                  {napcatBusy === "install" ? "正在下载安装…" : "安装 NapCat"}
                </button>
              </div>
            ) : napcatBusy === "start" || (!nc.running && napcatBusy === null && napcatNote === "") ? (
              <div className="wx-actions">
                <span className="hint">{napcatBusy === "start" ? "正在启动并配置 NapCat（最长约 3 分钟）…" : "NapCat 已安装，尚未启动"}</span>
              </div>
            ) : null}
            {nc.installed && !nc.running && napcatBusy === null && (
              <div className="wx-actions">
                <button type="button" className="primary sm" onClick={() => { void runNapcat("start"); }}>
                  启动 NapCat
                </button>
              </div>
            )}
            {napcatQrDataUrl !== "" && (
              <div className="ob-qr">
                <img src={napcatQrDataUrl} alt="QQ 登录二维码" width={200} height={200} />
                <div className="hint">用手机 QQ 扫码登录。扫过一次后小茉会记住这个号，下次启动自动登录。</div>
              </div>
            )}
            {nc.phase === "waiting_qrcode" && napcatQrDataUrl === "" && (
              <div className="hint">正在生成登录二维码…</div>
            )}
          </>
        )}
        {napcatNote !== "" && <div className="hint">{napcatNote}</div>}

        {/* 兜底：自备 NapCat 的手动连接。收起，主路径走完的人不该看到这一堆字段。 */}
        <details className="ob-manual">
          <summary>我自己已经装了 NapCat，手动填地址</summary>
          <div className="hint">
            NapCat 网络配置里开两个服务再填进来：HTTP 服务器（发件，默认监听 3000）+
            WebSocket 服务器（收件，默认 3001；不填只发不收）。
          </div>
          <label>发件 · HTTP API 地址
            <input value={obAddr} placeholder="http://127.0.0.1:3000"
              onChange={(e) => setObAddr(e.target.value)} />
          </label>
          <label>收件 · WebSocket 服务器地址
            <input value={obWsAddr} placeholder="ws://127.0.0.1:3001"
              onChange={(e) => setObWsAddr(e.target.value)} />
          </label>
          <div className="wx-actions">
            <button type="button" className="primary sm" disabled={obAddrBusy}
              onClick={() => { void connectOneBot(); }}>
              {obAddrBusy ? "连接中…" : "保存并连接"}
            </button>
            <button type="button" className="pf-ghost" disabled={obAddrBusy}
              onClick={() => { setObStatus(null); setProbeTick((t) => t + 1); }}>
              重试
            </button>
            {obAddrNote !== "" && <span className="hint">{obAddrNote}</span>}
          </div>
        </details>
      </div>
    );
  };

  /** 换渠道时清掉上一个渠道的探测残留；探测过程中的旧值保留到新值回来，
   *  面板不闪烁（从前每轮绑定轮询都会把探测态清空重测，卡每 5 秒闪一次）。 */
  useEffect(() => {
    setObStatus(null); setObAvatar("");
  }, [backend]);

  /** 协议端地址的现值只在进卡（换渠道）时回填一次；探测重试不回填，
   *  否则用户正在手动地址框里打字，5 秒后被探测流程悄悄覆盖掉。 */
  useEffect(() => {
    if (backend !== "onebot") return;
    let cancelled = false;
    qqApi.fetchOneBotSettings().then((s) => {
      if (cancelled) return;
      setObAddr(s.httpBase);
      setObWsAddr(s.wsUrl);
    }).catch(() => { /* 拿不到就空着，面板里可填 */ });
    return () => { cancelled = true; };
  }, [backend]);

  /** OneBot 渠道下探测协议端：读出它登录的账号（头像+昵称）供一键绑定；连不上给引导文案。
   *  绑定态也要探——「需要处理」徽章背后必须有一个能就地处理的入口，不能只亮红灯。
   *  依赖里用「绑没绑」而不是 binding 对象：5 秒轮询每次都生成新对象，按对象比较会让
   *  这条 effect 每轮重启、探测态先清空再重取——这就是卡面闪烁的来源。 */
  const boundNow = binding !== null;
  useEffect(() => {
    if (backend !== "onebot") return;
    let cancelled = false;
    setObAvatar("");
    qqApi.fetchOneBotStatus().then(async (info) => {
      if (cancelled) return;
      setObStatus(info);
      if (info.reachable && info.userId !== "") {
        try {
          const a = await avatarApi.fetchQqAvatar(info.userId);
          if (!cancelled) setObAvatar(a.url);
        } catch { /* 没抓到头像就摆字块，不影响绑定 */ }
      }
    }).catch(() => {
      if (!cancelled) setObStatus({ reachable: false, userId: "", nickname: "", error: "探测请求失败" });
    });
    return () => { cancelled = true; };
  }, [backend, obProbeTick, boundNow]);

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
    setObQqNumber("");   // 换联系人：上一位填的号不能带过来
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

  /** OneBot 模式：把真实 QQ 号绑到这位联系人（一键绑定与手填共用），成功后刷新快照。 */
  const saveOneBotBind = async (numberOverride?: string): Promise<void> => {
    const number = (numberOverride ?? obQqNumber).trim();
    if (number === "") { setErr("先填上这位联系人的真实 QQ 号"); return; }
    setErr(""); setNote(""); setBusy(true);
    try {
      const owner = obOwnerQq.trim();
      const data = await qqApi.bindQQOneBot(contactId, { qqNumber: number, ...(owner !== "" ? { ownerQq: owner } : {}) });
      if (!alive.current) return;
      setObQqNumber("");
      setBinding(data.binding);
      setConfigured(data.configured);
      setStatus(data.status);
      boundRef.current = data.binding !== null;
      setNote("真实 QQ 号已绑定。这位联系人的 QQ 消息会经 OneBot 协议端收发；在协议端用这个号登录后即生效。");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
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

  /** 头部徽章的语义色：在跑=绿、要人处理=琥珀、连接中=呼吸蓝、其余=灰。 */
  const badgeTone: ChannelTone = binding === null
    ? "muted"
    : binding.status === "connected" ? "ok"
      : binding.status === "attention" ? "warn"
        : binding.status === "connecting" ? "busy" : "muted";
  const badgeLabel = binding !== null ? qqApi.QQ_STATUS_LABEL[binding.status] : configured ? "未绑定" : "未配置";

  /** 绑定口令的复制：口令固定两个字，但要让人确信「复制到了」。 */
  const copyKeyword = (): void => {
    if (attempt === null) return;
    void navigator.clipboard?.writeText(attempt.keyword).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* 剪贴板拿不到就让人手选，code 本来 user-select:all */ });
  };

  /**
   * 官方渠道的三步流程图：凭据 → 绑定 → 激活会话。
   * 从前这三步是散在各处的条件渲染块，人不知道整体走到哪了；步骤条把终局画出来。
   */
  const officialSteps: ChannelStep[] = [
    {
      label: "创建机器人凭据",
      state: configured ? "done" : "current",
      hint: configured ? "凭据已就绪" : "扫码自动建号，或手填已有 AppID",
    },
    {
      label: "绑定这位联系人",
      state: binding?.hasUserOpenId === true ? "done"
        : configured ? "current" : "todo",
      hint: binding?.hasUserOpenId === true ? "已认领到对方的 openid" : undefined,
    },
    {
      label: "发消息激活会话",
      state: binding?.hasReplyWindow === true ? "done"
        : binding !== null ? "current" : "todo",
      hint: binding?.hasReplyWindow === true ? undefined : "由对方先发一条消息，进入一小时被动回复窗口",
    },
  ];

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
        <span className="ch-channel-icon ch-channel-qq" aria-hidden="true"><Bot size={17} strokeWidth={1.8} /></span>
        <div>
          <div className="pf-set-title">QQ 连接</div>
          <div className="pf-model-hint">
            {backend === "onebot"
              ? "真实 QQ 号在协议端（NapCat 等）登录收发：可主动发消息，图、语音、视频、文件与表情都原生支持；每个 QQ 群单独隔离。"
              : "接官方 QQ 开放平台机器人：私聊并入联系人主私聊、与应用和微信共用同一段上下文，画好的图与文件直接发出；每个 QQ 群单独隔离。"}
          </div>
        </div>
        <ChannelBadge tone={badgeTone} label={badgeLabel}
          title={binding?.status === "attention" && binding.lastError !== "" ? binding.lastError : undefined} />
      </div>

      {/* 接入渠道：全局一份（进程级），放在这张卡上因为 QQ 配置的家在这里。
          选中即热切换：旧渠道收线、新渠道上线，卡片随渠道换形态，不用重启。 */}
      <div className="qq-backend">
        <div className="qq-backend-head">
          <span className="qq-backend-label">接入渠道</span>
          <span className="hint">全局设置，所有联系人共用；切换即时生效</span>
        </div>
        <div className="seg" role="radiogroup" aria-label="QQ 接入渠道">
          <button type="button" className={backend === "official" ? "on" : ""} disabled={backendBusy}
            onClick={() => setConfirmBackend("official")}>
            官方机器人
          </button>
          <button type="button" className={backend === "onebot" ? "on" : ""} disabled={backendBusy}
            onClick={() => setConfirmBackend("onebot")}>
            OneBot 协议端
          </button>
        </div>
        <div className="hint">
          {backend === "onebot"
            ? "真实 QQ 号在 NapCat / LLOneBot 等协议端登录：可主动发消息，face/商城表情、图/语音/视频/文件都原生支持。"
            : "QQ 开放平台官方机器人：扫码建号最稳，受平台主动消息与富媒体权限限制。"}
        </div>
        {backendNote !== "" && (
          <div className="qq-backend-note">
            <span>{backendNote}</span>
          </div>
        )}
      </div>

      {/* 表情能力跟着渠道选择器走：换 official / OneBot 时，「她能发哪种表情」正是这一刻要看的。 */}
      <EmoteCapability />

      {/* 官方渠道的三步流程图：三步全走完（已绑定 + 窗口已激活）就收起——
          已连接的人不需要每天看一遍流程，状态徽章已经说明一切。 */}
      {backend === "official" && !(binding !== null && binding.hasUserOpenId && binding.hasReplyWindow) && (
        <ChannelSteps steps={officialSteps} label="QQ 官方连接步骤" />
      )}

      {/* ① 凭据：每位联系人一份，拿到一次就收起。扫码是官方推荐路径，手填留作兜底。
          官方后端专属；OneBot 后端在协议端登录真实号，下面走另一个表单。 */}
      {backend === "official" && (!configured || editingCreds) && (
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

      {/* ①' OneBot 后端：不用扫码/凭据，真实 QQ 号在协议端登录，这里只存「号→联系人」映射。
          绑定入口先探测协议端、直接读出它登录的账号——头像 + 昵称 + 一键确认，
          手填只是「登录的不是这个号」时的兜底，两条路不该长得一样重要。 */}
      {backend === "onebot" && (!configured || !binding) && (
        <div className="qq-creds">
          {obStatus === null ? (
            <div className="hint">正在探测 OneBot 协议端…</div>
          ) : obStatus.reachable && obStatus.userId !== "" ? (
            <>
              <div className="hint">协议端已连上，当前登录的账号是：</div>
              <div className="ob-account">
                {obAvatar !== ""
                  ? <img className="ob-account-avatar" src={obAvatar} alt="" />
                  : <span className="ob-account-avatar ob-account-fallback">{(obStatus.nickname || obStatus.userId).slice(0, 1)}</span>}
                <div className="ob-account-meta">
                  <div className="ob-account-name">{obStatus.nickname !== "" ? obStatus.nickname : "QQ 用户"}</div>
                  <div className="ob-account-num">{obStatus.userId}</div>
                </div>
                <button type="button" className="primary sm" disabled={busy}
                  onClick={() => { void saveOneBotBind(obStatus.userId); }}>
                  {busy ? "绑定中…" : "绑定这个号"}
                </button>
              </div>
              {!obManual && (
                <button type="button" className="pf-ghost" onClick={() => setObManual(true)}>
                  登录的不是这个号？手动填
                </button>
              )}
            </>
          ) : (
            obConnectPanel("setup")
          )}
          {(obManual || (obStatus !== null && !obStatus.reachable)) && (
            <>
              <label>真实 QQ 号
                <input value={obQqNumber} inputMode="numeric" maxLength={15} placeholder="如 123456789"
                  onChange={(e) => setObQqNumber(e.target.value.replace(/[^\d]/g, ""))} />
              </label>
              <label>主人 QQ 号（可选，群聊里据此认出哪句是主人说的）
                <input value={obOwnerQq} inputMode="numeric" maxLength={15} placeholder="你自己的 QQ 号"
                  onChange={(e) => setObOwnerQq(e.target.value.replace(/[^\d]/g, ""))} />
              </label>
              <div className="wx-actions">
                <button type="button" className="primary sm" disabled={busy || obQqNumber.trim() === ""}
                  onClick={() => { void saveOneBotBind(); }}>
                  {busy ? "保存中…" : "绑定到这位联系人"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ①'' OneBot 已绑定：协议端连接状态必须一直可见、可就地处理——
          「需要处理」徽章亮着却无处可点，是最伤产品的死角。在线时给账号对账，离线时给修复路径。 */}
      {backend === "onebot" && binding && obStatus !== null && (
        <div className="qq-creds">
          {obStatus.reachable && obStatus.userId !== "" ? (
            <div className="ob-account">
              {obAvatar !== ""
                ? <img className="ob-account-avatar" src={obAvatar} alt="" />
                : <span className="ob-account-avatar ob-account-fallback">{(obStatus.nickname || obStatus.userId).slice(0, 1)}</span>}
              <div className="ob-account-meta">
                <div className="ob-account-name">协议端已连接：{obStatus.nickname !== "" ? obStatus.nickname : "QQ 用户"}</div>
                <div className="ob-account-num">
                  {obStatus.userId}
                  {(() => {
                    // 绑定号在视图里是脱敏的（••••1234），只能拿尾号对账：对不上就明说，别让用户蒙在鼓里。
                    const boundTail = binding.userOpenId.replace(/[^0-9]/g, "");
                    return boundTail !== "" && !obStatus.userId.endsWith(boundTail) ? " · 与绑定号不一致" : "";
                  })()}
                </div>
              </div>
            </div>
          ) : (
            /* 绑定态走到这里 = 已绑但协议端探测不通：恢复语境，别再念「绑定」的流程。 */
            obConnectPanel("repair")
          )}
        </div>
      )}

      {/* ② 已配置但这位联系人还没绑（官方后端专属：开认领窗口，让对方发「绑定」两个字）。 */}
      {backend === "official" && configured && !binding && !attempt && (
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
      {backend === "official" && configured && binding && !editingCreds && (
        <div className="wx-actions">
          <button type="button" className="pf-ghost" disabled={busy} onClick={() => setEditingCreds(true)}>换机器人凭据</button>
        </div>
      )}

      {/* 凭据配好了但 openid 还没认领（大肥鱼这种：只在群里说过话、从没私聊绑过）：
          必须给「去绑定」入口——否则 bot 回你"去绑定"你却无处可点。 */}
      {backend === "official" && binding && !binding.hasUserOpenId && !attempt && (
        <div className="wx-actions">
          <button type="button" className="primary sm" disabled={busy} onClick={() => { void startBind(); }}>
            {busy ? "正在开启…" : "去绑定（认领 openid）"}
          </button>
          <span className="hint">
            还没认领到 openid：点了之后，让{who}在 QQ 里**私聊**给机器人发「绑定」两个字（10 分钟内有效）。
            没认领到 openid，主动私聊消息和被动回复窗口都用不了。
          </span>
        </div>
      )}

      {attempt && (
        /* 绑定口令是这一步唯一要做的事：大字号 + 复制按钮 + 呼吸点说明「正在等」，不再是一行小字。 */
        <div className="qq-bind-try">
          <div className="qq-bind-try-main">
            <span className="qq-bind-try-label">让{who}在 QQ 里给机器人发这个词（10 分钟内有效）</span>
            <div className="qq-bind-try-row">
              <code className="qq-code" id="qq-bind-code">{attempt.keyword}</code>
              <button type="button" className="pf-ghost" onClick={copyKeyword} aria-label="复制绑定口令">
                {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={1.9} />}
                {copied ? "已复制" : "复制"}
              </button>
              <button type="button" className="pf-ghost" onClick={() => { stopPoll(); setAttempt(null); }}>取消</button>
            </div>
          </div>
          <div className="ch-waiting"><span className="ch-waiting-dot" aria-hidden="true" />正在等这条消息，发完这页自己就会认出来，不用刷新。</div>
        </div>
      )}

      {note !== "" && <ChannelNote tone="success">{note}</ChannelNote>}
      {/* 回复窗口是官方渠道的概念（msg_id 一小时被动窗口）；OneBot 真实号没有这个限制，别把官方的规矩念给 OneBot 用户听。 */}
      {binding && backend === "official" && !binding.hasReplyWindow && (
        <ChannelNote tone="info">
          还没有可回复的窗口：请先在 QQ 里给{who}发一条消息。官方只允许在收到消息后的一小时内被动回复，
          超窗的句子要靠「消息能力」权限，没申请到就发不出去（发不出去会显示在下面）。
        </ChannelNote>
      )}
      {binding && binding.status === "attention" && binding.lastError !== "" && (
        <ChannelNote tone="error">{binding.lastError}</ChannelNote>
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
                      : !conv.enabled ? "已停用 · 不响应群消息"
                      : `${conv.titleSource === "custom" ? "自定义名称" : "平台群名"} · 群聊`}
                  </span>
                  <button type="button" className="qq-conv-clear" title="清除该群全部历史（会话保留，继续收发）"
                    onClick={() => { setErr(""); setClearTarget(conv); }}>
                    <Trash2 size={11} strokeWidth={1.9} />清除历史
                  </button>
                  <button type="button" className="qq-conv-remove"
                    title={conv.enabled && conv.leftAt === null ? "先停用收件才能移除" : "从群聊列表彻底移除"}
                    onClick={() => { setErr(""); setRemoveTarget(conv); }}>
                    <CircleMinus size={11} strokeWidth={1.9} />移除群聊
                  </button>
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
        </div>
      )}
      {err !== "" && <ChannelNote tone="error">{err}</ChannelNote>}

      {/* 危险操作单独分层：与微信卡同一套结构，解绑的后果就地写明。 */}
      {binding && (
        <div className="ch-danger-row">
          <button type="button" className="pf-ghost wx-danger" disabled={busy} onClick={() => setConfirmOff(true)}>
            解除绑定
          </button>
          <span className="ch-danger-hint">解绑后这位联系人不再收发 QQ 消息，对话记录保留，重新绑定即可接回。</span>
        </div>
      )}

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
              <ChannelNote tone="info">手机 QQ 扫这个码。扫完自动接着往下走，不用回来填什么。</ChannelNote>
            </>
          ) : (
            <>
              <ChannelNote tone="error">{qr.error}</ChannelNote>
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

      {confirmBackend !== null && (
        <Modal onClose={() => setConfirmBackend(null)} label="切换 QQ 接入渠道" className="wx-modal">
          <div className="modal-title">切换到{confirmBackend === "onebot" ? " OneBot 协议端" : "官方机器人"}？</div>
          <div className="modal-sub">
            {confirmBackend === "onebot"
              ? "所有联系人的 QQ 将改走 OneBot 协议端收发，官方机器人的凭据保留但暂停使用。协议端没在运行时 QQ 消息会暂时中断，连接后自动恢复；绑定入口会读出协议端登录的号供确认。"
              : "所有联系人的 QQ 将改走官方 Bot 平台收发，需要已扫码配置机器人凭据；协议端登录不受影响但暂停使用。"}
            {" "}切换全局生效、即时完成，随时可以切回来。
          </div>
          <div className="add-row">
            <button type="button" onClick={() => setConfirmBackend(null)}>取消</button>
            <button type="button" className="primary" disabled={backendBusy}
              onClick={() => { const target = confirmBackend; setConfirmBackend(null); if (target !== null) void switchBackend(target); }}>
              确认切换
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
