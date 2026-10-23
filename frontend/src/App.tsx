import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import Rail from "./components/Rail";
import Sidebar from "./components/Sidebar";
import AboutDialog from "./components/AboutDialog";
import UndoBar from "./components/UndoBar";
import type { SettingsTab } from "./features/settings/SettingsView";
import type { PersonaDraft } from "./lib/persona-doc";
import ChatView from "./features/chat/ChatView";
import AssistantDialog from "./features/assistant/AssistantDialog";
// 状态 / 设置 / 资料三个视图按需加载：它们本来就是条件渲染，进聊天页没理由先付掉那几屏表单代码。
// ChatView 与助手弹窗保持同步加载——助手弹窗常驻挂载以保住草稿，拆它省不了东西。
const StatusView = lazy(() => import("./features/status/StatusView"));
const SettingsView = lazy(() => import("./features/settings/SettingsView"));
const ProfileView = lazy(() => import("./features/profile/ProfileView"));
// 首次设置弹窗只有第一趟用得上，不该让每个老用户都付它的代码。
const OnboardingDialog = lazy(() => import("./features/onboarding/OnboardingDialog"));
import type { ProfilePage } from "./features/profile/constants";
import { useHashRoute } from "./hooks/useHashRoute";
import { useNarrow } from "./hooks/useNarrow";
import { useDetailHistory } from "./hooks/useDetailHistory";
import type { ViewKey } from "./types";
import { settingsApi, contactId, setContactId } from "./api";
import { getCachedContacts, refreshContacts, subscribeContacts } from "./lib/contactsStore";
import { showMessageNotification, syncAppBadge } from "./lib/notify";
import { startOutbox } from "./lib/outbox";
import type { ContactItem } from "./types";

type ProfileTarget = { mode: "create" | "edit"; id: string; page?: ProfilePage; draft?: PersonaDraft } | null;

/** 应用外壳：三栏布局 + 视图路由。各视图自己拉数据，切走即销毁。 */
export default function App(): JSX.Element {
  const [current, setCurrent] = useState<string>(contactId());
  const [view, navigate] = useHashRoute();
  const [ownerName, setOwnerName] = useState("");
  const [ownerAvatar, setOwnerAvatar] = useState("");
  const [characterName, setCharacterName] = useState("小茉");
  const [contactAvatar, setContactAvatar] = useState("");
  /** 聊天框按联系人的开关：思考过程折叠条 / 工具卡片（纯显示）+ 图像生成（决定露不露「画一张」）。缺省按各自默认处理。 */
  const [chatDisplay, setChatDisplay] = useState<{ showThinking: boolean; showTools: boolean; imageGen: boolean; streamReveal: boolean }>({ showThinking: true, showTools: true, imageGen: false, streamReveal: false });
  /** 全应用未读消息数（Rail「对话」图标红点）。 */
  const [unreadTotal, setUnreadTotal] = useState(0);
  /** 上一轮各联系人的未读数：只对“这次涨了”的部分发通知，首帧不补历史红点。 */
  const unreadSeenRef = useRef<Map<string, number> | null>(null);
  /** 后端可达性：联系人轮询失败即视为断连，界面顶部明说，而不是各视图静默空白。 */
  const [netOk, setNetOk] = useState(true);
  const [about, setAbout] = useState(false);
  /** 首次设置弹窗。完成标记存服务端 kv（settings.onboarding），桌面与手机打开同一份数据不会各弹一次。 */
  const [onboarding, setOnboarding] = useState(false);
  const [profile, setProfile] = useState<ProfileTarget>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("owner");
  const [settingsAdvanced, setSettingsAdvanced] = useState(false);
  /** 访问过的顶层视图保留挂载：切走只是 display:none，回来不再重新挂载、拉数据。 */
  const [visitedViews, setVisitedViews] = useState<Set<ViewKey>>(() => new Set([view]));
  /** 窄屏「对话」双页流：list=整屏会话列表，chat=整屏会话（微信手机端点进/返回）。 */
  const narrow = useNarrow();
  const [chatPage, setChatPage] = useState<"list" | "chat">("list");
  /** 会话区有没有选中的联系人。归档/删掉当前这位后置 false：留空态等人自己挑，别顺手把小茉顶上来。 */
  const [chatOpen, setChatOpen] = useState(true);
  /** 内置设置助手：召唤式弹窗，不占顶层导航。关闭只隐藏，会话状态留在里面。 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  /** 当前联系人的名字与头像 + 全站未读数：全部由 contactsStore 的唯一轮询链供数。 */
  const applyContactMeta = useCallback((list: ContactItem[]): void => {
    const c = list.find((x) => x.id === contactId());
    if (c) {
      setCharacterName(c.name || "小茉");
      setContactAvatar(c.avatar || "");
    }
    setChatDisplay((prev) => {
      const next = { showThinking: c?.showThinking !== false, showTools: c?.showTools !== false, imageGen: c?.imageGen === true, streamReveal: c?.streamReveal === true };
      return prev.showThinking === next.showThinking && prev.showTools === next.showTools && prev.imageGen === next.imageGen && prev.streamReveal === next.streamReveal ? prev : next;
    });
    const prev = unreadSeenRef.current;
    if (prev) {
      const newly = list.filter((x) => (x.unread || 0) > (prev.get(x.id) ?? 0));
      if (document.visibilityState !== "visible") {
        for (const x of newly.slice(0, 3)) {
          void showMessageNotification({
            title: x.name,
            body: x.preview || `来了 ${x.unread} 条新消息`,
            contactId: x.id,
          });
        }
      }
    }
    unreadSeenRef.current = new Map(list.map((x) => [x.id, x.unread || 0]));
    const total = list.reduce((n, x) => n + (x.unread || 0), 0);
    syncAppBadge(total);
    setUnreadTotal(total);
  }, []);

  useEffect(() => subscribeContacts(applyContactMeta), [applyContactMeta]);
  useEffect(() => { refreshContacts(); }, []);
  useEffect(() => { startOutbox(); }, []);
  useEffect(() => {
    setVisitedViews((prev) => {
      if (prev.has(view)) return prev;
      const next = new Set(prev);
      next.add(view);
      return next;
    });
  }, [view]);
  const refreshContactMeta = refreshContacts;
  const prefetchView = useCallback((key: ViewKey): void => {
    if (key === "status") void import("./features/status/StatusView");
    else if (key === "settings") void import("./features/settings/SettingsView");
  }, []);

  // 断网提示：contactsStore 是唯一探测点，它广播 down/ok 事件。
  useEffect(() => {
    const down = (): void => setNetOk(false);
    const up = (): void => setNetOk(true);
    window.addEventListener("xiaomo:net-down", down);
    window.addEventListener("xiaomo:net-ok", up);
    return () => {
      window.removeEventListener("xiaomo:net-down", down);
      window.removeEventListener("xiaomo:net-ok", up);
    };
  }, []);

  // 恢复上次拖出来的中栏宽度（--side-w 现在只有联系人列表这一栏在用）
  useEffect(() => {
    const w = localStorage.getItem("xiaomo.sideWidth");
    if (w) document.documentElement.style.setProperty("--side-w", w);
  }, []);

  // 空闲时把三个懒加载视图的 chunk 先取回来。产物文件名带 hash、服务端发永久缓存
  // （见 server.ts 的 IMMUTABLE），这份流量只花一次；换掉的是首次点进状态/设置/资料页
  // 时那一整个网络往返的白等（穿透访问实测 135ms）。
  useEffect(() => {
    const prefetch = (): void => {
      void import("./features/status/StatusView");
      void import("./features/settings/SettingsView");
      void import("./features/profile/ProfileView");
    };
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(prefetch, 2000);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(prefetch, { timeout: 5000 });
    return () => cancelIdleCallback(idle);
  }, []);

  useEffect(() => {
    void settingsApi.fetchSettings()
      .then((d) => {
        setOwnerName(d.persona?.owner?.name || "");
        setOwnerAvatar(d.persona?.owner?.avatar || "");
        // 没走完首次设置就开一次弹窗；「稍后设置」不写标记，所以下次打开还会来，
        // 直到他在收尾那一步按下「开始聊天」。
        if (d.onboardingDone !== true) setOnboarding(true);
      })
      .catch(() => {});
  }, []);

  // 下面这些回调都要进 ChatView / Sidebar 的 props。它们必须是稳定引用：
  // 会话页有些一次性初始化（首屏拉取、轮询链）挂在「每实例一次」的 effect 上，
  // 而调用方回调的引用会顺着依赖链把整条路拽重跑——实测代价是草稿被吞、视口被砸回底部。
  const pick = useCallback((id: string): void => {
    setContactId(id);
    setCurrent(id);
    setChatOpen(true);
    // 资料页是叠在会话页上的浮层：从联系人列表点另一位，等于「离开这一位、去和那一位说话」。
    // 不收掉的话点谁都没反应（列表页还露在左边，右边那屏却仍是刚进来的人）。
    setProfile(null);
    // 页头芯片/名字立刻跟到新联系人——不等下一轮联系人轮询（空闲时会退避到 10s）
    applyContactMeta(getCachedContacts());
    setChatPage("chat"); // 窄屏：从会话列表点进来
  }, [applyContactMeta]);

  /** 当前这位被归档/彻底删掉：会话区退回空态（窄屏退回列表），作用域悄悄回到 default 供状态页用。 */
  const leaveChat = useCallback((): void => {
    setContactId("default");
    setCurrent("default");
    setChatOpen(false);
    setChatPage("list");
    applyContactMeta(getCachedContacts());
  }, [applyContactMeta]);

  const navigateTo = useCallback((key: ViewKey): void => {
    setProfile(null);
    if (key === "chat") setChatPage("list"); // 微信式：切到「对话」先回列表页
    // Rail 图标进设置落在「我的资料」；「主对话模型」从状态页的跳转进入。
    if (key === "settings") setSettingsTab("owner");
    // 「展开高级参数」是 openModelSettings 的一次性意图，不是常驻状态。
    // 不复位的话，此后每次进设置页点「主对话模型」都会不请自开编辑弹窗并抢焦点。
    setSettingsAdvanced(false);
    navigate(key);
  }, [navigate]);

  /** 点系统通知：切到对应联系人并打开具体会话。 */
  useEffect(() => {
    const open = (event: Event): void => {
      const id = (event as CustomEvent<{ contactId?: string }>).detail?.contactId;
      if (!id) return;
      setProfile(null);
      pick(id);
      navigate("chat");
    };
    window.addEventListener("xiaomo:open-contact", open);
    return () => window.removeEventListener("xiaomo:open-contact", open);
  }, [navigate, pick]);

  // 全局快捷键（桌面端键盘通道）：Ctrl/Cmd+1..3 切视图，Ctrl/Cmd+K 召唤助手，Ctrl/Cmd+F 搜联系人。
  // 处理器要读最新的 view / narrow / profile，所以用「最新 ref」持有它；
  // 而 window 上的绑定一次就够。
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => { });
  useEffect(() => {
    const keys = ["chat", "status", "settings"] as const;
    keyHandlerRef.current = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const num = Number(e.key);
      const target = keys[num - 1];
      if (target) {
        e.preventDefault();
        navigateTo(target);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setAssistantOpen(true);
        return;
      }
      if (key === "f") {
        e.preventDefault();
        // 具体会话里 Ctrl+F 搜这段对话；列表页仍搜联系人。
        if (view === "chat" && chatOpen && (!narrow || chatPage === "chat")) {
          window.dispatchEvent(new Event("xiaomo:chat-search"));
          return;
        }
        // 搜联系人 = 回会话列表页聚焦搜索框——列表页就是联系人的唯一管理入口
        navigateTo("chat");
        // 等列表页真正挂上再聚焦：80ms 定时器在窄屏首帧常常赶不上，
        // 用户按下 Ctrl+F 看到的就是一次静默失败。
        requestAnimationFrame(() => requestAnimationFrame(() => {
          (document.getElementById("sideSearch") as HTMLInputElement | null)?.focus();
        }));
      }
    };
  });

  useEffect(() => {
    // 此前这个 effect 没有依赖数组：App 每渲染一次就解绑再重绑一次全局
    // keydown，而 contactsStore 每 10s 广播一次全站重渲染。
    const h = (e: KeyboardEvent): void => keyHandlerRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /** 点左上角头像：直达设置页「全局用户资料」。 */
  const openProfilePage = useCallback((): void => {
    setSettingsTab("owner");
    setProfile(null);
    navigate("settings");
  }, [navigate]);

  /** 上下文提示里的「去设置」：进「主对话模型」并把高级参数展开——输入上限就藏在那里，
   *  不展开等于把人领到门口又让他自己找门。 */
  const openModelSettings = useCallback((): void => {
    setSettingsTab("model");
    setSettingsAdvanced(true);
    setProfile(null);
    navigate("settings");
  }, [navigate]);

  /** 总览卡片右上角的跳转：落到设置页对应的 tab。 */
  const openSettingsTab = useCallback((tab: SettingsTab): void => {
    setSettingsTab(tab);
    setProfile(null);
    navigate("settings");
  }, [navigate]);

  /** 「管理联系人」：直接进「对话」列表页（增删/资料/搜索都在那里），不再有独立抽屉。 */
  const manageContacts = useCallback((): void => { navigateTo("chat"); }, [navigateTo]);

  /** 会话页顶栏那几个入口：都要跟着当前联系人走，且引用要稳定（见 pick 上方说明）。 */
  const editCurrentProfile = useCallback(() => { setProfile({ mode: "edit", id: current }); }, [current]);
  const openCurrentSection = useCallback((page: "memory" | "proactive") => {
    setProfile({ mode: "edit", id: current, page });
  }, [current]);
  const backToChatList = useCallback(() => { setChatPage("list"); refreshContacts(); }, []);
  const openContactProfile = useCallback((mode: "create" | "edit", id: string, draft?: PersonaDraft) => {
    setProfile({ mode, id, draft });
  }, []);

  /** 搜索命中要跳到位：消息命中滚到那句话并闪一下，记忆命中直接打开那位的记忆分区。
   *  从前两类都只切到人——号称「回车搜全历史」，点完还得自己在长会话里往下翻。 */
  const [focusMsg, setFocusMsg] = useState<number | null>(null);
  const openHit = useCallback((kind: "message" | "memory", id: string, messageId: number): void => {
    if (kind === "memory") {
      setContactId(id); setCurrent(id); setChatOpen(true);
      applyContactMeta(getCachedContacts());
      setProfile({ mode: "edit", id, page: "memory" });
      return;
    }
    pick(id);
    setFocusMsg(messageId);
  }, [applyContactMeta, pick]);

  const activeView = profile ? "" : view;
  // 微信式布局：中栏联系人列表只属于「对话」；其余视图内容区全宽，
  // 按联系人展开的页面用页头下拉芯片做轻量切换（「管理联系人」直接跳回对话列表页）。
  const showSidebar = view === "chat";
  // 非对话视图内容区全宽（助手是覆盖式弹窗，不参与这套布局）
  const wideShell = !showSidebar;

  // 窄屏「对话」列表页：侧栏铺满整屏当主页，ChatView 仍挂载（CSS 藏 content），返回零成本、草稿不丢。
  const chatListPage = narrow && view === "chat" && !profile && chatPage === "list";

  // 系统/浏览器返回键：先退回会话列表，而不是直接退出网站。
  // 资料页是叠在会话页上的又一层：各自压一条历史，逐层返回。
  useDetailHistory("chat", narrow && view === "chat" && chatPage === "chat", backToChatList);
  useDetailHistory("profile", narrow && profile !== null,
    () => { setProfile(null); refreshContactMeta(); });

  // 微信式全屏：进入具体会话，或打开资料页叠层（聊天的下一级）时，
  // 隐藏底部导航栏让位全屏；列表页仍保留。跳切换视图时 profile 统一清空，导航自然回来。
  // 助手是覆盖式弹窗，不参与这套页态。
  const chatFull = narrow && (profile !== null || (view === "chat" && chatPage === "chat"));

  // 会话页从「藏」变「显」时通知 ChatView：display:none 期间量不到高度、轮询链也在睡觉，
  // 醒来的这一下既要补滚到底，也要补一拍拉取——否则进来看到的是睡觉前的旧列表。
  // 两种藏法都算：窄屏的列表页/会话页双页流，以及任意宽度下资料页叠层压住会话页。
  const chatShown = chatOpen && view === "chat" && profile === null && (!narrow || chatPage === "chat");
  const wasChatShownRef = useRef(chatShown);
  useEffect(() => {
    if (chatShown && !wasChatShownRef.current) window.dispatchEvent(new Event("xiaomo:chat-shown"));
    wasChatShownRef.current = chatShown;
  }, [chatShown]);

  /** 助手是覆盖式弹窗，盖在任何一屏之上都能召唤——包括资料页（它只是 #content 里的又一层，
   *  z 档 78/79 本就在其上方）。它自己的「助手设置」不再甩到外面的资料页去了：
   *  那一屏现在渲染在弹窗内部（见 AssistantDialog），返回就回到原来那条会话；
   *  从前是收起弹窗、开一张身后的整页资料，返回只把整页收掉，人再也回不到助手里。 */
  const asstShown = assistantOpen;
  const shellRef = useRef<HTMLDivElement>(null);
  // 遮罩只挡鼠标，键盘 Tab 仍能溜进身后的会话框——弹窗开着就把整个壳层置为 inert。
  useEffect(() => { if (shellRef.current) shellRef.current.inert = asstShown; }, [asstShown]);

  return (
    <>
    <div id="shell" ref={shellRef} className={[wideShell ? "wide" : "", chatListPage ? "chat-list-on" : "", chatFull ? "chat-full" : ""].join(" ").trim() || undefined}>
      <Rail
        active={activeView}
        onNavigate={navigateTo}
        onPrefetch={prefetchView}
        ownerName={ownerName}
        ownerAvatar={ownerAvatar}
        onAbout={() => setAbout(true)}
        onOnboarding={() => setOnboarding(true)}
        onOpenProfilePage={openProfilePage}
        onOpenAssistant={() => setAssistantOpen(true)}
        unreadChat={unreadTotal}
      />
      {showSidebar && (
        <Sidebar
          current={chatOpen ? current : ""}
          onPick={pick}
          onLeaveCurrent={leaveChat}
          onContactsChanged={refreshContactMeta}
          onOpenProfile={openContactProfile}
          onOpenHit={openHit}
        />
      )}
      {/* Suspense 边界选在三处条件渲染的共同父级上；Suspense 不产生 DOM，
          不会插进 #shell 的网格。 */}
      <Suspense fallback={<div className="view active" id="view-boot"><div className="section"><div className="skeleton" style={{ height: 64 }} /></div></div>}>
      <main id="content">
        {!netOk && (
          <div className="net-tip" role="alert">连不上本地服务，消息暂时收发不了——请确认后台还在运行（桌面端检查应用是否开着）。</div>
        )}
        {/* 资料页是叠在当前视图上的浮层：底下那层只让出 .active、不卸载。
            整棵子树重挂会把顶栏状态与输入框计量打回初值（返回时「闪一下」），
            没发出去的草稿也会一起丢掉。 */}
        {(visitedViews.has("status") || view === "status") && (
          <div className={"view" + (view === "status" && !profile ? " active" : "")} id="view-status">
            {/* 状态页整体不跟联系人走（换人别打断你正在看的那张表）；
                只有记忆召回试验台按联系人重挂载，见 StatusView 里的 key */}
            <StatusView active={view === "status" && profile === null}
              contactId={current} contactName={characterName} contactAvatar={contactAvatar}
              onOpenContacts={manageContacts} onSwitchContact={pick} goSettings={openSettingsTab} />
          </div>
        )}
        {(visitedViews.has("settings") || view === "settings") && (
          <div className={"view" + (view === "settings" && !profile ? " active" : "")} id="view-settings">
            <SettingsView onChanged={refreshContactMeta} initialTab={settingsTab} revealAdvanced={settingsAdvanced} onOwnerAvatar={setOwnerAvatar} />
          </div>
        )}
        {(visitedViews.has("chat") || view === "chat") && (
          <div className={"view" + (view === "chat" && !profile ? " active" : "")} id="view-chat">
            {chatOpen ? (
            <ChatView key={current} msgScope={current} focusMessageId={focusMsg} onFocusHandled={() => setFocusMsg(null)}
              characterName={characterName} ownerName={ownerName}
              ownerAvatar={ownerAvatar} contactAvatar={contactAvatar}
              showThinking={chatDisplay.showThinking} showTools={chatDisplay.showTools}
              imageGenOn={chatDisplay.imageGen} streamReveal={chatDisplay.streamReveal}
              onSwitchContact={pick}
              onEditProfile={editCurrentProfile}
              onOpenSection={openCurrentSection}
              onOpenModelSettings={openModelSettings}
              onOpenOnboarding={() => setOnboarding(true)}
              onContactArchived={leaveChat}
              onBack={narrow ? backToChatList : undefined} />
            ) : (
              <div className="chat-blank"><div className="empty">还没有打开会话 · 从联系人列表里挑一位开始聊天</div></div>
            )}
          </div>
        )}
        {profile && (
          <div className="view active" id="view-profile">
            <ProfileView
              key={profile.mode + ":" + profile.id}
              mode={profile.mode}
              contactId={profile.id}
              initialDraft={profile.draft}
              initialPage={profile.page}
              onBack={() => { setProfile(null); refreshContactMeta(); }}
              onSaved={(id) => {
                if (profile.mode === "create") {
                  setContactId(id); setCurrent(id); setChatOpen(true);
                  // 建完就地转成编辑态：模型绑定 / 回放轮数 / 陪伴能力都只在编辑态开放，
                  // 直接弹回聊天等于把人刚建好的人留在"只能改人格"的半配好状态。
                  setProfile({ mode: "edit", id });
                }
                refreshContactMeta();
              }}
            />
          </div>
        )}
      </main>
      </Suspense>
    </div>
    <AssistantDialog open={asstShown} onClose={() => setAssistantOpen(false)}
      ownerName={ownerName} ownerAvatar={ownerAvatar} />
    {about && <AboutDialog onClose={() => setAbout(false)} />}
    {onboarding && (
      <Suspense fallback={null}>
        <OnboardingDialog
          onClose={() => setOnboarding(false)}
          onFinished={() => setOnboarding(false)}
          onGotoCapabilities={() => { setOnboarding(false); openSettingsTab("capability"); }}
        />
      </Suspense>
    )}
    {/* 反悔条挂在全局而不是各视图里：它得在"刚做完事的那一眼"里看得见。
        放在记忆列表末尾时，18 张卡的窄屏上它落在 top:2810——等于没有。 */}
    <UndoBar />
    </>
  );
}
