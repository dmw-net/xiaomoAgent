import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronRight, CircleMinus, Copy, Ellipsis, PencilLine, Search, Settings2, SlidersHorizontal, Trash2, UsersRound, X } from "lucide-react";
import { avatarApi, qqApi, type QQBindingView, type QQConversationView, type QQStatus } from "../../api";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";
import ToggleSwitch from "../../components/ToggleSwitch";
import { ChannelBadge, ChannelNote, ChannelSteps, type ChannelStep, type ChannelTone } from "./ChannelKit";

const GROUP_TITLE_MAX = 40;
const TRIGGER_MODE_LABEL: Record<QQConversationView["triggerMode"], string> = {
  at: "仅 @",
  at_keyword: "@ 或关键词",
  all: "全部消息",
};

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
export function QQSection({ contactId }: { contactId: string }): JSX.Element {
  const [binding, setBinding] = useState<QQBindingView | null>(null);
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<QQStatus>("not-configured");
  /** 后端选型：official=官方 Bot（扫码/凭据），onebot=第三方协议端（填真实 QQ 号）。 */
  const [backend, setBackend] = useState<"official" | "onebot">("official");
  /** 渠道切换：只改当前联系人的活动后端；两套配置和适配器都保留。 */
  const [backendBusy, setBackendBusy] = useState(false);
  const [backendNote, setBackendNote] = useState("");
  /** OneBot 模式：待填的真实 QQ 号。 */
  const [obQqNumber, setObQqNumber] = useState("");
  /** 主人的真实 QQ 号：私聊投递目标，群聊里也据此把主人从群成员里认出来。 */
  const [obOwnerQq, setObOwnerQq] = useState("");
  /** OneBot 已连接态：就地编辑登录 QQ 与「我的 QQ」，免解绑重绑。 */
  const [editingObBind, setEditingObBind] = useState(false);
  /** OneBot 绑定入口：协议端探测结果（登录账号/连通性），带头像地址与登录状态。 */
  const [obStatus, setObStatus] = useState<qqApi.OneBotLoginInfo | null>(null);
  const [obAvatar, setObAvatar] = useState("");
  const [ownerAvatar, setOwnerAvatar] = useState("");
  const [obProbeTick, setProbeTick] = useState(0);
  /** 协议端连接面板：地址可就地改（热生效），不再逼用户去改配置文件。 */
  const [obAddr, setObAddr] = useState("");
  const [obWsAddr, setObWsAddr] = useState("");
  const [obAddrBusy, setObAddrBusy] = useState(false);
  const [obAddrNote, setObAddrNote] = useState("");
  /** 小茉托管的 NapCat：一键安装/启动/登录的状态源与动作入口。 */
  const [napcat, setNapcat] = useState<qqApi.NapcatStatus | null>(null);
  const [napcatBusy, setNapcatBusy] = useState<"install" | "start" | "relogin" | null>(null);
  const [napcatNote, setNapcatNote] = useState("");
  const [napcatQr, setNapcatQr] = useState("");
  const [napcatProbeTick, setNapcatProbeTick] = useState(0);
  const [confirmSwitchQq, setConfirmSwitchQq] = useState(false);
  /** 渠道切换确认框：只影响当前联系人，但会立刻改变收发路径，仍需明确确认。 */
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
  /** 群消息响应方式的行内编辑（OneBot 渠道）：与改名同一套展开形态。 */
  const [editingTriggerId, setEditingTriggerId] = useState("");
  const [triggerModeDraft, setTriggerModeDraft] = useState<QQConversationView["triggerMode"]>("at");
  const [triggerKeywordsDraft, setTriggerKeywordsDraft] = useState("");
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [toggleBusyId, setToggleBusyId] = useState("");
  const [clearTarget, setClearTarget] = useState<QQConversationView | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<QQConversationView | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  /** 群操作菜单一次只展开一个；日常只露收件开关，重命名/响应/清理/移除按需展开。 */
  const [openGroupMenuId, setOpenGroupMenuId] = useState("");
  /** 连接级设置（暂停、主动消息、断开）集中在一个弹层，卡片首屏不再出现三个入口。 */
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [toggleProactiveBusyId, setToggleProactiveBusyId] = useState("");
  /** 「绑定」两个字复制成功的瞬时反馈；两秒后自己落回复制图标。 */
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

  /** 接入方式是联系人级配置；挂载或切换联系人时读出这位联系人当前的活动渠道。 */
  useEffect(() => {
    let cancelled = false;
    qqApi.fetchQQBackend(contactId).then((data) => {
      if (cancelled) return;
      setBackend(data.backend);
    }).catch(() => { /* 拿不到就保持 official 默认态 */ });
    return () => { cancelled = true; };
  }, [contactId]);

  /** 切换当前联系人的接入渠道；成功后刷新绑定态，另一渠道的凭据/绑定原样保留。 */
  const switchBackend = async (next: "official" | "onebot"): Promise<void> => {
    if (backendBusy || next === backend) return;
    setBackendBusy(true); setBackendNote("");
    try {
      const r = await qqApi.setQQBackend(next, contactId);
      if (!alive.current) return;
      setBackend(r.backend);
      setBackendNote("当前联系人的接入方式已切换，即时生效");
      void refresh();
    } catch (e: unknown) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBackendBusy(false);
    }
  };

  /** 托管 NapCat 的状态轮询：只在 OneBot 渠道、且还没登录完成时转；登录成功即停。
   *  napcatProbeTick 用来在切换 QQ 后重新打开轮询，等新二维码和新账号出现。 */
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
        if (s.loggedIn) {
          setNapcatNote("");
          setProbeTick((t) => t + 1);
          if (timer !== null) { clearInterval(timer); timer = null; }
        }
      } catch { /* 状态拿不到就下一轮再说 */ }
    };
    void probeNapcat();
    timer = setInterval(() => { void probeNapcat(); }, 4000);
    return () => { cancelled = true; if (timer !== null) clearInterval(timer); };
  }, [backend, napcatProbeTick]);

  /** 一键安装 / 一键启动：动作是长请求，期间锁按钮，结束把状态轮询立刻拉一把。 */
  const runNapcat = async (action: "install" | "start" | "relogin"): Promise<void> => {
    if (napcatBusy !== null) return;
    setNapcatBusy(action); setNapcatNote("");
    if (action === "relogin") {
      setNapcat(null);
      setNapcatQr("");
      setObStatus(null);
      setNapcatNote("正在退出当前 QQ 并重启 NapCat…");
    }
    try {
      const r = await qqApi.napcatAction(action);
      if (!alive.current) return;
      if (!r.ok) setNapcatNote(r.error);
      else if (r.needsQr === true) {
        setNapcatNote(action === "relogin"
          ? "正在重启 NapCat，用手机 QQ 扫码登录新的账号。"
          : "NapCat 已启动，用手机 QQ 扫下面的二维码登录（下次启动自动登录，不用再扫）");
      } else {
        setNapcatNote(action === "install" ? "安装完成，正在启动…" : "NapCat 已就绪");
      }
      setProbeTick((t) => t + 1);
      setNapcatProbeTick((t) => t + 1);
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
        state: nc !== null && nc.loggedIn ? "done" : nc !== null && nc.installed ? "current" : "todo",
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

  /** 「我的 QQ」与登录 QQ 用同一种身份卡：头像也从 QQ 号取，不再只是一行文字。 */
  useEffect(() => {
    const ownerQq = binding?.ownerQq?.trim() ?? "";
    if (ownerQq === "") { setOwnerAvatar(""); return; }
    let cancelled = false;
    avatarApi.fetchQqAvatar(ownerQq).then((a) => {
      if (!cancelled) setOwnerAvatar(a.url);
    }).catch(() => { /* 没抓到头像就摆字块 */ });
    return () => { cancelled = true; };
  }, [binding?.ownerQq]);

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
    setClearTarget(null); setClearBusy(false); setRemoveTarget(null); setRemoveBusy(false); setGroupQuery(""); setOpenGroupMenuId(""); setShowConnectionSettings(false);
    setObQqNumber("");   // 换联系人：上一位填的号不能带过来
    setObOwnerQq(""); setEditingObBind(false); setConfirmSwitchQq(false);
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
      setEditingCreds(false); setManualOpen(false);
      setNote("凭据已保存。接下来点「绑定你的 QQ」，然后用你的 QQ 私聊机器人发送「绑定」。");
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

  /** OneBot 模式：把真实 QQ 号绑到这位联系人（一键绑定 / 手填 / 编辑复用同一入口），成功后刷新快照。
   *  编辑态保存成功只清草稿，不再把成功提示写成「已绑定」——那是首次绑定才该说的话。 */
  const saveOneBotBind = async (numberOverride?: string): Promise<void> => {
    const number = (numberOverride ?? obQqNumber).trim();
    if (number === "") { setErr("先填上这位联系人的真实 QQ 号"); return; }
    setErr(""); setNote(""); setBusy(true);
    try {
      const owner = obOwnerQq.trim();
      // 编辑态必须把 ownerQq 原样带过去（空串=清除）；省略字段后端会保留旧值，「留空=清除」就假了。
      const data = await qqApi.bindQQOneBot(contactId, editingObBind
        ? { qqNumber: number, ownerQq: owner }
        : { qqNumber: number, ...(owner !== "" ? { ownerQq: owner } : {}) });
      if (!alive.current) return;
      const wasEditing = editingObBind;
      setObQqNumber(""); setObOwnerQq(""); setEditingObBind(false);
      setBinding(data.binding);
      setConfigured(data.configured);
      setStatus(data.status);
      boundRef.current = data.binding !== null;
      setNote(wasEditing
        ? "绑定信息已更新，即时生效。"
        : "真实 QQ 号已绑定。这位联系人的 QQ 消息会经 OneBot 协议端收发；在协议端用这个号登录后即生效。");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /** OneBot 已绑定态：就地编辑绑定信息——进编辑前用原值回填（脱敏的 userOpenId 填不回去，得拿后端回传的原始 qqNumber）。 */
  const startEditObBind = (): void => {
    if (binding === null) return;
    setErr(""); setNote("");
    setObQqNumber(binding.qqNumber ?? "");
    setObOwnerQq(binding.ownerQq ?? "");
    setEditingObBind(true);
  };
  const cancelEditObBind = (): void => {
    setObQqNumber(""); setObOwnerQq(""); setEditingObBind(false);
  };
  /**
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
            setEditingCreds(false);
            setNote(`已连上机器人 ${st.appId ?? ""}。接下来点「绑定你的 QQ」，然后用你的 QQ 私聊机器人发送「绑定」。`);
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
            setNote("QQ 绑定成功。");
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
    setOpenGroupMenuId("");
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
    setOpenGroupMenuId(""); setErr(""); setEditingTriggerId(""); setEditingGroupId(conv.id); setGroupTitleDraft(conv.title);
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

  const startTriggerEdit = (conv: QQConversationView): void => {
    setOpenGroupMenuId(""); setErr(""); setEditingGroupId(""); setEditingTriggerId(conv.id);
    setTriggerModeDraft(conv.triggerMode); setTriggerKeywordsDraft(conv.triggerKeywords);
  };

  const saveTrigger = async (conv: QQConversationView): Promise<void> => {
    if (triggerBusy) return;
    if (triggerModeDraft === "at_keyword" && triggerKeywordsDraft.trim() === "") {
      setErr("选了「@ 或关键词」就得填至少一个关键词"); return;
    }
    setTriggerBusy(true); setErr("");
    try {
      const data = await qqApi.setQQConversationTrigger(contactId, conv.id, triggerModeDraft, triggerKeywordsDraft);
      if (!alive.current) return;
      setBinding((prev) => prev === null ? prev : {
        ...prev,
        conversations: prev.conversations.map((item) => item.id === conv.id
          ? { ...item, triggerMode: data.triggerMode, triggerKeywords: data.triggerKeywords } : item),
      });
      setEditingTriggerId(""); setTriggerKeywordsDraft("");
    } catch (e: unknown) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setTriggerBusy(false);
    }
  };

  // 平台补发的入群事件/渠道迁移可能留下「QQ 群」空壳；没有消息也没有真实群名时不展示。
  // 真正进群或收到第一条群消息后，它会自动重新出现。
  const groupConversations = [...(binding?.conversations ?? [])]
    .filter((conv) => !(conv.messageCount === 0 && conv.titleSource === "auto" && conv.title.trim() === "QQ 群"))
    .sort((a, b) => {
      if ((a.leftAt !== null) !== (b.leftAt !== null)) return a.leftAt !== null ? 1 : -1;
      const byTime = new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
      return Number.isFinite(byTime) && byTime !== 0 ? byTime : a.title.localeCompare(b.title, "zh-CN");
    });
  const normalizedGroupQuery = groupQuery.trim().toLocaleLowerCase();
  const visibleGroups = normalizedGroupQuery === ""
    ? groupConversations
    : groupConversations.filter((conv) => conv.title.toLocaleLowerCase().includes(normalizedGroupQuery));
  const leftGroups = groupConversations.filter((conv) => conv.leftAt !== null).length;

  /** 头部徽章的语义色：在跑=绿、要人处理=琥珀、连接中=呼吸蓝、其余=灰。 */
  const badgeTone: ChannelTone = binding === null
    ? "muted"
    : binding.status === "connected" ? "ok"
      : binding.status === "attention" ? "warn"
        : binding.status === "connecting" ? "busy" : "muted";
  const badgeLabel = binding !== null ? qqApi.QQ_STATUS_LABEL[binding.status] : configured ? "未绑定" : "未配置";

  /** 固定词「绑定」的复制反馈：内容很短，也要让人确信真的复制到了。 */
  const copyKeyword = (): void => {
    if (attempt === null) return;
    void navigator.clipboard?.writeText(attempt.keyword).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* 剪贴板拿不到就让人手选，code 本来 user-select:all */ });
  };

  /**
   * 官方渠道只有两步接入：创建机器人 → 用你自己的 QQ 完成绑定。
   * 一小时回复窗口是绑定后的平台运行限制，不是安装步骤；把它混进流程会让人误以为还没接好。
   */
  const officialSteps: ChannelStep[] = [
    {
      label: "创建 QQ 机器人",
      state: configured ? "done" : "current",
      hint: configured ? "机器人已创建" : "扫码创建，或手填已有 AppID",
      action: configured && !editingCreds ? (
        <button type="button" className="pf-ghost" disabled={busy}
          onClick={() => setEditingCreds(true)}>
          换机器人凭据
        </button>
      ) : undefined,
    },
    {
      label: "绑定你的 QQ",
      state: binding?.hasUserOpenId === true ? "done"
        : configured ? "current" : "todo",
      hint: binding?.hasUserOpenId === true
        ? "已绑定你的 QQ"
        : status === "connecting"
          ? "机器人正在连接，连上后即可绑定"
          : status !== "connected"
            ? "机器人连接异常，检查连接设置"
            : "在手机 QQ 私聊机器人，发送「绑定」",
      action: configured && !editingCreds && !attempt ? (
        <button type="button" className="primary sm" disabled={busy || status !== "connected"}
          onClick={() => { void startBind(); }}>
          {busy ? "正在开启…" : "绑定你的 QQ"}
        </button>
      ) : undefined,
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
              ? "真实 QQ 号登录；私聊和本机共用聊天，QQ 群独立。"
              : "官方机器人；私聊和本机共用聊天，主动消息需你先发一条。"}
          </div>
        </div>
        <ChannelBadge tone={badgeTone} label={badgeLabel}
          title={binding?.status === "attention" && binding.lastError !== "" ? binding.lastError : undefined} />
      </div>

      {/* 接入方式：每位联系人独立选择；两种适配器常驻，切换只改变当前联系人的路由。 */}
      <div className="qq-backend">
        <div className="qq-backend-head">
          <span className="qq-backend-label">接入方式</span>
          <span className="qq-backend-scope">仅当前联系人</span>
        </div>
        <div className="seg" role="radiogroup" aria-label="当前联系人的 QQ 接入方式">
          <button type="button" className={backend === "official" ? "on" : ""} disabled={backendBusy}
            onClick={() => setConfirmBackend("official")}>
            官方机器人
          </button>
          <button type="button" className={backend === "onebot" ? "on" : ""} disabled={backendBusy}
            onClick={() => setConfirmBackend("onebot")}>
            OneBot 协议端
          </button>
        </div>
        {backendNote !== "" && (
          <div className="qq-backend-note">
            <span>{backendNote}</span>
          </div>
        )}
      </div>

      {/* 官方接入只展示到「绑定完成」为止；回复窗口属于日常使用状态，不再伪装成接入步骤。 */}
      {backend === "official" && binding?.hasUserOpenId !== true && (
        <ChannelSteps steps={officialSteps} label="QQ 官方接入步骤" />
      )}

      {/* ① 凭据：每位联系人一份，拿到一次就收起。扫码是官方推荐路径，手填留作兜底。
          官方后端专属；OneBot 后端在协议端登录真实号，下面走另一个表单。 */}
      {backend === "official" && (!configured || editingCreds) && (
        <div className="qq-creds">
          <div className="hint">
            {editingCreds
              ? "重新扫码会替换当前机器人，也可以手填已有 AppID/AppSecret。"
              : "扫码创建当前联系人的机器人，凭据会自动填入。机器人需先在 QQ 开放平台发布，否则会停在沙箱。"}
          </div>
          <div className="wx-actions">
            <button type="button" className="primary sm" disabled={busy} onClick={() => { void startQr(); }}>
              {busy ? "正在生成…" : editingCreds ? "重新扫码更换机器人" : "扫码创建机器人"}
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
          绑定入口先探测协议端、直接读出它登录的账号——头像 + 昵称 + 一键确认；
          想换号时走明确的「切换 QQ」，不靠猜用户意图自动退出当前账号。 */}
      {backend === "onebot" && (!configured || !binding) && (
        <div className="qq-creds">
          {obStatus === null ? (
            <div className="hint">正在探测 OneBot 协议端…</div>
          ) : obStatus.reachable && obStatus.userId !== "" ? (
            <>
              <div className="hint">协议端已连上，当前登录的账号是：</div>
              <div className="ob-account ob-account-card">
                {obAvatar !== ""
                  ? <img className="ob-account-avatar" src={obAvatar} alt="" />
                  : <span className="ob-account-avatar ob-account-fallback">{(obStatus.nickname || obStatus.userId).slice(0, 1)}</span>}
                <div className="ob-account-meta">
                  <div className="ob-account-name">{obStatus.nickname !== "" ? obStatus.nickname : "QQ 用户"}</div>
                  <div className="ob-account-num">{obStatus.userId}</div>
                </div>
                <div className="ob-card-actions">
                  {napcat?.installed === true && (
                    <button type="button" className="pf-ghost" disabled={napcatBusy !== null}
                      onClick={() => setConfirmSwitchQq(true)}>
                      切换 QQ
                    </button>
                  )}
                  <button type="button" className="primary sm" disabled={busy}
                    onClick={() => { void saveOneBotBind(obStatus.userId); }}>
                    {busy ? "绑定中…" : "绑定这个号"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            obConnectPanel("setup")
          )}
          {obStatus !== null && !obStatus.reachable && (
            <>
              <label>登录 QQ
                <input value={obQqNumber} inputMode="numeric" maxLength={15} placeholder="如 123456789"
                  onChange={(e) => setObQqNumber(e.target.value.replace(/[^\d]/g, ""))} />
              </label>
              <label>我的 QQ（用于私聊收发和群里识别你）
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

      {/* ①'' OneBot 已绑定：绑定信息卡（号 + 主人号 + 协议端连接状态）+ 就地编辑，
           不再要「解绑再绑」改「我的 QQ」。协议端掉线时整块退化成修复面板。 */}
      {backend === "onebot" && binding && obStatus !== null && !editingObBind && (
        <div className="qq-creds">
          {obStatus.reachable && obStatus.userId !== "" ? (
            <>
              <div className="ob-account ob-account-card">
                {obAvatar !== ""
                  ? <img className="ob-account-avatar" src={obAvatar} alt="" />
                  : <span className="ob-account-avatar ob-account-fallback">{(obStatus.nickname || obStatus.userId).slice(0, 1)}</span>}
                <div className="ob-account-meta">
                  <div className="ob-account-name">QQ 已连接：{obStatus.nickname !== "" ? obStatus.nickname : "QQ 用户"}</div>
                  <div className="ob-account-num">
                    {obStatus.userId}
                    {(() => {
                      // 绑定号在视图里是脱敏的（••••1234），只能拿尾号对账：对不上就明说，别让用户蒙在鼓里。
                      const boundTail = binding.userOpenId.replace(/[^0-9]/g, "");
                      return boundTail !== "" && !obStatus.userId.endsWith(boundTail) ? " · 账号已变化" : "";
                    })()}
                  </div>
                </div>
                {napcat?.installed === true && (
                  <button type="button" className="pf-ghost ob-card-action" disabled={napcatBusy !== null}
                    onClick={() => setConfirmSwitchQq(true)}>
                    切换 QQ
                  </button>
                )}
              </div>
              <div className="ob-account ob-account-card">
                {ownerAvatar !== ""
                  ? <img className="ob-account-avatar" src={ownerAvatar} alt="" />
                  : <span className="ob-account-avatar ob-account-fallback">我</span>}
                <div className="ob-account-meta">
                  <div className="ob-account-name">我的 QQ</div>
                  <div className="ob-account-num">{binding.ownerQq !== "" ? binding.ownerQq : "未设置"}</div>
                </div>
                <button type="button" className="pf-ghost ob-card-action" disabled={busy}
                  onClick={() => { void startEditObBind(); }}>
                  修改
                </button>
              </div>
              {binding.ownerQq === "" && (
                <ChannelNote tone="info">填写「我的 QQ」后，私聊才能发给你，群里也能认出你。</ChannelNote>
              )}
            </>
          ) : (
            /* 绑定态走到这里 = 已绑但协议端探测不通：恢复语境，别再念「绑定」的流程。 */
            obConnectPanel("repair")
          )}
        </div>
      )}

      {/* ①''' OneBot 就地编辑：原值回填登录 QQ + 我的 QQ，保存即热更新，不用解绑重绑。 */}
      {backend === "onebot" && binding && editingObBind && (
        <div className="qq-creds ob-edit">
          <div className="ob-edit-head">
            <span className="ob-edit-title">编辑连接信息</span>
            <span className="hint">保存即时生效；改「登录 QQ」后，协议端需要切换到对应账号。</span>
          </div>
          <label>登录 QQ
            <input value={obQqNumber} inputMode="numeric" maxLength={15} placeholder="如 123456789"
              onChange={(e) => setObQqNumber(e.target.value.replace(/[^\d]/g, ""))} />
          </label>
          <label>我的 QQ（用于私聊收发和群里识别你；留空=清除）
            <input value={obOwnerQq} inputMode="numeric" maxLength={15} placeholder="你自己的 QQ 号"
              onChange={(e) => setObOwnerQq(e.target.value.replace(/[^\d]/g, ""))} />
          </label>
          <div className="wx-actions">
            <button type="button" className="primary sm" disabled={busy || obQqNumber.trim() === ""}
              onClick={() => { void saveOneBotBind(); }}>
              {busy ? "保存中…" : "保存修改"}
            </button>
            <button type="button" className="pf-ghost" disabled={busy} onClick={() => { void cancelEditObBind(); }}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 绑定按钮放在第二步行尾；这里只保留绑定进行中的等待窗口。 */}
      {attempt && (
        /* 固定词「绑定」是这一步唯一要做的事：大字号 + 复制按钮 + 等待状态。 */
        <div className="qq-bind-try">
          <div className="qq-bind-try-main">
            <span className="qq-bind-try-label">用你的 QQ 私聊机器人，发送「绑定」（10 分钟内有效）</span>
            <div className="qq-bind-try-row">
              <code className="qq-code" id="qq-bind-code">{attempt.keyword}</code>
              <button type="button" className="pf-ghost" onClick={copyKeyword} aria-label="复制「绑定」">
                {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={1.9} />}
                {copied ? "已复制" : "复制"}
              </button>
              <button type="button" className="pf-ghost" onClick={() => { stopPoll(); setAttempt(null); }}>取消</button>
            </div>
          </div>
          <div className="ch-waiting"><span className="ch-waiting-dot" aria-hidden="true" />正在等这条消息，发完这页自己就会认出来，不用刷新。</div>
        </div>
      )}

      {note !== "" && !(backend === "official" && binding?.hasUserOpenId !== true) && (
        <ChannelNote tone="success">{note}</ChannelNote>
      )}
      {/* 回复窗口是官方渠道的运行限制，只在已经绑定你的 QQ 后展示。 */}
      {binding && binding.hasUserOpenId && backend === "official" && !binding.hasReplyWindow && (
        <ChannelNote tone="info">
          暂时不能主动找你：QQ 官方只允许机器人在收到你消息后的 1 小时内继续回复。用你的 QQ 给它发一条消息即可恢复。
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
            {leftGroups > 0 && <span className="qq-conv-list-status">{leftGroups} 个已离群</span>}
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
          ) : editingTriggerId === conv.id ? (
            <form key={conv.id} className="qq-conv-rename"
              onSubmit={(e) => { e.preventDefault(); void saveTrigger(conv); }}
              onKeyDown={(e) => { if (e.key === "Escape" && !triggerBusy) setEditingTriggerId(""); }}>
              <div className="qq-conv-rename-field">
                <span>群消息响应方式</span>
                <div className="seg qq-conv-trigger-seg" role="radiogroup" aria-label="群消息响应方式">
                  <button type="button" className={triggerModeDraft === "at" ? "on" : ""} disabled={triggerBusy}
                    onClick={() => setTriggerModeDraft("at")}>仅 @</button>
                  <button type="button" className={triggerModeDraft === "at_keyword" ? "on" : ""} disabled={triggerBusy}
                    onClick={() => setTriggerModeDraft("at_keyword")}>@ 或关键词</button>
                  <button type="button" className={triggerModeDraft === "all" ? "on" : ""} disabled={triggerBusy}
                    onClick={() => setTriggerModeDraft("all")}>全部消息</button>
                </div>
              </div>
              {triggerModeDraft === "at_keyword" && (
                <label className="qq-conv-rename-field">
                  <span>关键词（逗号、顿号或空格分隔）</span>
                  <input value={triggerKeywordsDraft} maxLength={200} autoFocus
                    placeholder="例如：小茉、在吗、出来"
                    onChange={(e) => setTriggerKeywordsDraft(e.target.value)} />
                </label>
              )}
              <div className="qq-conv-rename-foot">
                <span>
                  {triggerModeDraft === "all"
                    ? "群里每条消息都会触发机器人回复，发言频繁的群注意消耗。"
                    : triggerModeDraft === "at_keyword"
                      ? "被 @ 或消息里出现任一关键词时回复。"
                      : "只有 @ 机器人时回复；其余群消息不入库。"}
                </span>
                <div className="qq-conv-rename-actions">
                  <button type="button" className="qq-conv-cancel" disabled={triggerBusy}
                    onClick={() => setEditingTriggerId("")}>取消</button>
                  <button type="submit" className="qq-conv-save" disabled={triggerBusy}>
                    {triggerBusy ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div key={conv.id} className="qq-conv-item">
              <div className="qq-conv-row">
                <div className="qq-conv-main">
                  <div className="qq-conv-title-row">
                    <button type="button" className="qq-conv-open" aria-label={`打开群会话 ${conv.title}`}
                      onClick={() => openGroup(conv)}>
                      <span className="qq-conv-title">{conv.title}</span>
                    </button>
                  </div>
                  <div className="qq-conv-meta-row">
                    <span className="qq-conv-meta">
                      {conv.leftAt !== null
                        ? conv.messageCount > 0 ? "已离群 · 仅保留历史" : "已离群 · 历史已清除"
                        : !conv.enabled ? "已停用 · 不响应群消息"
                        : backend === "onebot" ? `响应：${TRIGGER_MODE_LABEL[conv.triggerMode]}` : "响应：仅 @"}
                    </span>
                  </div>
                </div>
                <div className="qq-conv-actions">
                  {/* 状态词（收件中/已停用/已离群）只是给人看的反馈；真正的开关语义
                      由 ariaLabel 补全，样式随 aria-checked 在 CSS 里染色，不再私有一套。 */}
                  <ToggleSwitch
                    checked={conv.enabled && conv.leftAt === null}
                    ariaLabel={`${conv.title}群消息接收`}
                    title={conv.leftAt !== null ? "机器人已被移出群聊或群已解散，仅保留历史" : conv.enabled ? "关闭群消息接收" : "开启群消息接收"}
                    disabled={toggleBusyId === conv.id || conv.leftAt !== null}
                    label={conv.leftAt !== null ? "已离群" : conv.enabled ? "收件中" : "已停用"}
                    onChange={() => { void toggleGroupEnabled(conv); }} />
                  <button type="button" className={"qq-conv-more-btn" + (openGroupMenuId === conv.id ? " open" : "")}
                    aria-label={`${conv.title}更多设置`} aria-expanded={openGroupMenuId === conv.id}
                    onClick={() => setOpenGroupMenuId(openGroupMenuId === conv.id ? "" : conv.id)}>
                    <Ellipsis size={17} strokeWidth={2} />
                  </button>
                </div>
              </div>
              {openGroupMenuId === conv.id && (
                <div className="qq-conv-more-panel">
                  <button type="button" className="qq-conv-menu-action" onClick={() => startRename(conv)}>
                    <PencilLine size={13} strokeWidth={1.9} />重命名
                  </button>
                  {backend === "onebot" && conv.leftAt === null && (
                    <button type="button" className="qq-conv-menu-action" onClick={() => startTriggerEdit(conv)}>
                      <SlidersHorizontal size={13} strokeWidth={1.9} />响应方式
                      <span className="qq-conv-menu-value">{TRIGGER_MODE_LABEL[conv.triggerMode]}</span>
                    </button>
                  )}
                  {conv.leftAt === null && (
                    <div className="qq-conv-menu-check" title="主动消息（到点提醒、主动关心）也会发到这个群；需先在 QQ 群设置里允许机器人主动发言。">
                      <ToggleSwitch label="群主动消息" labelSide="right"
                        checked={conv.groupProactive} disabled={toggleProactiveBusyId !== ""}
                        onChange={() => { void toggleGroupProactive(conv); }} />
                    </div>
                  )}
                  <div className="qq-conv-menu-danger">
                    <button type="button" onClick={() => { setOpenGroupMenuId(""); setErr(""); setClearTarget(conv); }}>
                      <Trash2 size={12} strokeWidth={1.9} />清除历史
                    </button>
                    <button type="button" disabled={conv.enabled && conv.leftAt === null}
                      title={conv.enabled && conv.leftAt === null ? "先停用收件再移除" : "从群聊列表彻底移除"}
                      onClick={() => { setOpenGroupMenuId(""); setErr(""); setRemoveTarget(conv); }}>
                      <CircleMinus size={12} strokeWidth={1.9} />移除群聊
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {visibleGroups.length === 0 && (
            /* 群名筛选无命中：窄列表里的空态，compact；图标沿用本卡已有的群聊图标。 */
            <EmptyState compact icon={<UsersRound size={18} strokeWidth={1.5} />} title="没有找到匹配的群名" />
          )}
          </div>
        </div>
      )}

      {binding && (
        <button type="button" className="qq-connection-manage" onClick={() => setShowConnectionSettings(true)}>
          <span className="qq-connection-manage-icon"><Settings2 size={16} strokeWidth={1.8} /></span>
          <span className="qq-connection-manage-copy">
            <strong>连接设置</strong>
            <small>{qqApi.QQ_STATUS_LABEL[binding.status]}{binding.proactive ? " · 主动发送：允许" : " · 主动发送：关闭"}</small>
          </span>
          <ChevronRight size={16} strokeWidth={1.8} className="qq-connection-manage-arrow" />
        </button>
      )}
      {err !== "" && <ChannelNote tone="error">{err}</ChannelNote>}

      {showConnectionSettings && binding && (
        <Modal onClose={() => { if (!busy) setShowConnectionSettings(false); }} label="QQ 连接设置"
          className="qq-settings-modal" placement="center"
          head={<div className="qq-settings-head">
            <div>
              <div className="qq-settings-title">连接设置</div>
              <div className="qq-settings-sub">操作即时生效。</div>
            </div>
            <button type="button" className="qq-settings-close" disabled={busy}
              onClick={() => setShowConnectionSettings(false)}>关闭</button>
          </div>}>
          <div className="qq-settings-list">
            <div className="qq-setting-row">
              <span className="qq-setting-copy">
                <strong>{binding.enabled ? "暂停连接" : "恢复连接"}</strong>
                <small>{binding.enabled ? "保留绑定与聊天记录。" : "恢复后将重新收发。"}</small>
              </span>
              <button type="button" className="pf-ghost qq-setting-action" disabled={busy}
                onClick={() => { void patchFlags({ enabled: !binding.enabled }); }}>
                {binding.enabled ? "暂停" : "恢复"}
              </button>
            </div>
            {/* 原来是裸 checkbox，同样是「开启某功能」的语义：统一换成滑块开关。
                label 改 div——不再用 label 包住控件，点击文案不切换，命中区由开关自身外扩补足。 */}
            <div className="qq-setting-row">
              <span className="qq-setting-copy">
                <strong>允许主动发送</strong>
                <small>{backend === "official" ? "小茉侧开关；QQ 平台仍可能限制主动消息。" : "提醒和主动关心可直接发到 QQ。"}</small>
              </span>
              <ToggleSwitch ariaLabel="允许主动发送" checked={binding.proactive} disabled={busy}
                onChange={(next) => { void patchFlags({ proactive: next }); }} />
            </div>
          </div>
          <div className="qq-settings-danger">
            <div className="qq-setting-copy">
              <strong>删除连接</strong>
              <small>移除绑定；聊天记录保留。</small>
            </div>
            <button type="button" className="pf-ghost wx-danger" disabled={busy}
              onClick={() => { setShowConnectionSettings(false); setConfirmOff(true); }}>
              删除
            </button>
          </div>
        </Modal>
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
        <Modal onClose={() => setConfirmOff(false)} label="删除 QQ 连接？" className="wx-modal">
          <div className="modal-title">删除 QQ 连接？</div>
          <div className="modal-sub">删除后这位联系人不再收发 QQ 消息，聊天记录会保留。之后可以重新绑定当前协议端账号。</div>
          <div className="add-row">
            <button type="button" onClick={() => setConfirmOff(false)}>取消</button>
            <button type="button" className="primary" disabled={busy} onClick={() => { void disconnect(); }}>确认删除</button>
          </div>
        </Modal>
      )}

      {confirmSwitchQq && (
        <Modal onClose={() => { if (napcatBusy === null) setConfirmSwitchQq(false); }} label="切换登录的 QQ" className="wx-modal">
          <div className="modal-title">切换登录的 QQ？</div>
          <div className="modal-sub">
            当前账号会退出，NapCat 重启后显示新的登录二维码。所有使用 OneBot 的联系人会暂时断开，扫码后再重新绑定需要的联系人。
          </div>
          <div className="add-row">
            <button type="button" disabled={napcatBusy !== null} onClick={() => setConfirmSwitchQq(false)}>取消</button>
            <button type="button" className="primary" disabled={napcatBusy !== null}
              onClick={() => { setConfirmSwitchQq(false); void runNapcat("relogin"); }}>
              切换并扫码
            </button>
          </div>
        </Modal>
      )}

      {confirmBackend !== null && (
        <Modal onClose={() => setConfirmBackend(null)} label="切换当前联系人的 QQ 接入方式" className="wx-modal">
          <div className="modal-title">切换当前联系人的接入方式？</div>
          <div className="modal-sub">
            {confirmBackend === "onebot"
              ? "改走 OneBot；官方配置会保留。"
              : "改走官方机器人；OneBot 配置会保留。"}
            {" "}只影响这位联系人，切换即时生效。
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
