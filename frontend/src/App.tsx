import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import Rail from "./components/Rail";
import Sidebar from "./components/Sidebar";
import Titlebar from "./components/Titlebar";
import AboutDialog from "./components/AboutDialog";
import UndoBar from "./components/UndoBar";
import ToastLayer from "./components/ToastLayer";
import EmptyState from "./components/EmptyState";
import { MessagesSquare, UserRoundPlus } from "lucide-react";
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
import { useScrollHoverLock } from "./hooks/useScrollHoverLock";
import type { ViewKey } from "./types";
import { settingsApi, contactId, setContactId } from "./api";
import { getCachedContacts, refreshContacts, subscribeContacts } from "./lib/contactsStore";
import { ensureToolState } from "./lib/toolsStore";
import { showMessageNotification, syncAppBadge } from "./lib/notify";
import { startOutbox } from "./lib/outbox";
import { startEventBus } from "./lib/eventBus";
import type { ContactItem, ContactConversationItem } from "./types";

type ProfileTarget = { mode: "create" | "edit"; id: string; page?: ProfilePage; draft?: PersonaDraft } | null;

/** 应用外壳：三栏布局 + 视图路由。各视图自己拉数据，切走即销毁。 */
export default function App(): JSX.Element {
  const [current, setCurrent] = useState<string>(contactId());
  /** 空 = 联系人主私聊；非空 = 当前打开的 QQ 群会话。 */
  const [conversation, setConversation] = useState<{ id: string; title: string; readOnly: boolean } | null>(null);
  const [view, navigate] = useHashRoute();
  // 滚动中暂停 hover 反馈（聊天描边 / 设置边框闪），见 hooks/useScrollHoverLock。
  useScrollHoverLock();
  const [ownerName, setOwnerName] = useState("");
  const [ownerAvatar, setOwnerAvatar] = useState("");
  const [characterName, setCharacterName] = useState("小茉");
  const [contactAvatar, setContactAvatar] = useState("");
  /** 聊天框按联系人的开关：思考过程折叠条 / 工具卡片（纯显示）+ 图像生成（决定露不露「画一张」）。缺省按各自默认处理。 */
  const [chatDisplay, setChatDisplay] = useState<{ showThinking: boolean; showTools: boolean; imageGen: boolean; streamReveal: boolean }>({ showThinking: true, showTools: true, imageGen: false, streamReveal: false });
  /** 当前联系人名下的独立上下文（主私聊 / 各 QQ 群），供聊天页切换器使用。 */
  const [contactConversations, setContactConversations] = useState<ContactConversationItem[]>([]);
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("home");
  /** 导航意图的序号：同一目的地连点两次（如在设置里逛着又点左上角头像回「我的资料」）
   *  也要生效。initialTab 相同的时候 effect 不会重跑，得靠这个计数器顶它一下。 */
  const [settingsNavSeq, setSettingsNavSeq] = useState(0);
  const [settingsAdvanced, setSettingsAdvanced] = useState(false);
  /** 「去设置」指定的模型档 id：设置页要把这一档直接打开，而不是全局在用的那一档。
   *  与 settingsAdvanced 同属一次性意图，跟着 settingsNavSeq 一起下发。 */
  const [settingsFocusProfile, setSettingsFocusProfile] = useState("");
  /** 标记本次导航已携带设置意图（tab/advanced 已设好），navigateTo 不要覆盖。 */
  const navIntendsSettingsRef = useRef(false);
  /** 设置页加载失败时的错误提示（null = 无错误）。 */
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  /** 访问过的顶层视图保留挂载：切走只是 display:none，回来不再重新挂载、拉数据。 */
  const [visitedViews, setVisitedViews] = useState<Set<ViewKey>>(() => new Set([view]));
  /** 窄屏「对话」双页流：list=整屏会话列表，chat=整屏会话（微信手机端点进/返回）。 */
  const narrow = useNarrow();
  const [chatPage, setChatPage] = useState<"list" | "chat">("list");
  /** 会话区有没有选中的联系人。归档/删掉当前这位后置 false：留空态等人自己挑，别顺手把小茉顶上来。 */
  const [chatOpen, setChatOpen] = useState(true);
  /** 内置设置助手：召唤式弹窗，不占顶层导航。关闭只隐藏，会话状态留在里面。 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  /** 助手弹窗要落到「助手设置」屏的请求序号：设置搜索每次跨页跳转递增一次，
      光靠 open 布尔不行（弹窗本来就有自己的落屏记忆，重复跳转也要生效）。 */
  const [assistantSettingsSeq, setAssistantSettingsSeq] = useState(0);
  /** 当前联系人的名字与头像 + 全站未读数：全部由 contactsStore 的唯一轮询链供数。 */
  const applyContactMeta = useCallback((list: ContactItem[]): void => {
    // 当前作用域指向的人不在列表里了（典型：设置页「全部清空」把老联系人整库清掉，
    // 而那条路不经过资料页的 leaveChat，current 还悬在旧 id 上）——之后状态页、
    // 对话页对这个 id 的每个请求都吃 404「联系人不存在」。收回到重新种出的 default。
    // 助手线程（assistant / assistant:<id>）不在联系人表里，是合法作用域，别动。
    if (list.length > 0) {
      const id = contactId();
      if (id !== "" && !id.startsWith("assistant") && !list.some((x) => x.id === id)) {
        setContactId("default");
        setCurrent("default");
      }
    }
    const c = list.find((x) => x.id === contactId());
    if (c) {
      setCharacterName(c.name || "小茉");
      setContactAvatar(c.avatar || "");
    }
    setContactConversations(c?.conversations ?? []);
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
            conversationId: x.conversationId ?? undefined,
            conversationTitle: x.conversationTitle,
            readOnly: x.conversationReadOnly === true,
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
  useEffect(() => { startEventBus(); }, []);
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
        // 直到用户在收尾那一步按下「开始聊天」。
        if (d.onboardingDone !== true) setOnboarding(true);
      })
      .catch((error: unknown) => {
        // 设置读取失败时显示轻量提示，而不是静默吞掉——用户需要知道为什么设置页是空的
        console.error("[app] 设置读取失败：", error);
        setSettingsLoadError("设置读取失败，点击重试");
      });
    // 预热工具台账缓存：聊天卡的动作短语、联系人页的档位文案都吃这份快照，
    // 启动时拉一次，之后这些读方缓存优先、基本零请求（写方挂载仍会强制拉新）。
    void ensureToolState().catch(() => undefined);
  }, []);

  const retrySettings = useCallback((): void => {
    setSettingsLoadError(null);
    void settingsApi.fetchSettings()
      .then((d) => {
        setOwnerName(d.persona?.owner?.name || "");
        setOwnerAvatar(d.persona?.owner?.avatar || "");
        if (d.onboardingDone !== true) setOnboarding(true);
      })
      .catch((error: unknown) => {
        console.error("[app] 重试设置读取失败：", error);
        setSettingsLoadError("设置读取失败，点击重试");
      });
  }, []);

  // 下面这些回调都要进 ChatView / Sidebar 的 props。它们必须是稳定引用：
  // 会话页有些一次性初始化（首屏拉取、轮询链）挂在「每实例一次」的 effect 上，
  // 而调用方回调的引用会顺着依赖链把整条路拽重跑——实测代价是草稿被吞、视口被砸回底部。
  const pick = useCallback((id: string, conversationId?: string | null, title?: string, readOnly?: boolean): void => {
    setContactId(id);
    setCurrent(id);
    // 主私聊可能带着数据库里的 local-* id，但它不是一个可切换来源；
    // 统一收成 null，群会话才保留独立 id。
    setConversation(conversationId && readOnly === true
      ? { id: conversationId, title: title || "QQ 群", readOnly: true }
      : null);
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

  /** 在联系人内部切换会话来源；联系人列表始终只保留一个统一入口。 */
  const openChatConversation = useCallback((conversationId: string | null, title?: string, readOnly?: boolean): void => {
    pick(current, conversationId, title, readOnly);
  }, [current, pick]);

  const navigateTo = useCallback((key: ViewKey): void => {
    setProfile(null);
    if (key === "chat") setChatPage("list"); // 微信式：切到「对话」先回列表页
    // Rail 图标进设置落在「我的资料」；「主对话模型」从状态页的跳转进入。
    if (key === "settings") setSettingsTab("owner");
    // 「展开高级参数」是 openModelSettings 的一次性意图，不是常驻状态。
    // 不复位的话，此后每次进设置页点「主对话模型」都会不请自开编辑弹窗并抢焦点。
    // 但 openModelSettings / openSettingsTab 已经设了 tab 和 advanced，不能被这里覆盖。
    // 用一个 ref 标记「本次导航已携带设置意图」，navigateTo 据此跳过重置。
    if (!navIntendsSettingsRef.current) {
      setSettingsAdvanced(false);
    } else {
      navIntendsSettingsRef.current = false;
    }
    navigate(key);
  }, [navigate]);

  /** 点系统通知：切到对应联系人并打开具体会话。 */
  useEffect(() => {
    const open = (event: Event): void => {
      const d = (event as CustomEvent<{ contactId?: string; conversationId?: string; conversationTitle?: string; readOnly?: boolean }>).detail;
      const id = d?.contactId;
      if (!id) return;
      setProfile(null);
      pick(id, d.conversationId, d.conversationTitle, d.readOnly);
      navigate("chat");
    };
    const openConversation = (event: Event): void => {
      const d = (event as CustomEvent<{ contactId?: string; conversationId?: string; title?: string; readOnly?: boolean }>).detail;
      if (!d?.contactId || !d.conversationId) return;
      setContactId(d.contactId);
      setCurrent(d.contactId);
      applyContactMeta(getCachedContacts());
      setConversation({ id: d.conversationId, title: d.title || "会话", readOnly: d.readOnly === true });
      setChatOpen(true);
      setProfile(null);
      setChatPage("chat");
      navigate("chat");
    };
    const conversationRemoved = (event: Event): void => {
      const d = (event as CustomEvent<{ contactId?: string; conversationId?: string }>).detail;
      if (!d?.contactId || !d.conversationId) return;
      setConversation((prev) => prev?.id === d.conversationId ? null : prev);
      if (d.contactId === contactId()) refreshContacts();
    };
    // 设置搜索「设置助手权限」的跨页落点：助手是召唤层，detail.settings 让弹窗直接落到它的设置屏。
    const openAssistant = (event: Event): void => {
      const d = (event as CustomEvent<{ settings?: boolean }>).detail;
      setAssistantOpen(true);
      if (d?.settings) setAssistantSettingsSeq((s) => s + 1);
    };
    window.addEventListener("xiaomo:open-contact", open);
    window.addEventListener("xiaomo:open-conversation", openConversation);
    window.addEventListener("xiaomo:conversation-removed", conversationRemoved);
    window.addEventListener("xiaomo:open-assistant", openAssistant);
    return () => {
      window.removeEventListener("xiaomo:open-contact", open);
      window.removeEventListener("xiaomo:open-conversation", openConversation);
      window.removeEventListener("xiaomo:conversation-removed", conversationRemoved);
      window.removeEventListener("xiaomo:open-assistant", openAssistant);
    };
  }, [navigate, pick, applyContactMeta]);

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
    setSettingsNavSeq((n) => n + 1);
    setProfile(null);
    navIntendsSettingsRef.current = true;
    navigate("settings");
  }, [navigate]);

  /** 上下文提示里的「去设置」：进「主对话模型」并把高级参数展开——输入上限就藏在那里，
   *  不展开等于把人领到门口又让用户自己找门。 */
  const openModelSettings = useCallback((profileId?: string): void => {
    setSettingsTab("model");
    setSettingsAdvanced(true);
    setSettingsFocusProfile(profileId ?? "");
    setSettingsNavSeq((n) => n + 1);
    setProfile(null);
    navIntendsSettingsRef.current = true;
    navigate("settings");
  }, [navigate]);

  /** 总览卡片右上角的跳转：落到设置页对应的 tab。 */
  const openSettingsTab = useCallback((tab: SettingsTab): void => {
    setSettingsTab(tab);
    setSettingsNavSeq((n) => n + 1);
    setProfile(null);
    navIntendsSettingsRef.current = true;
    navigate("settings");
  }, [navigate]);

  // 助手控制台等深层的「去设置」出口：走窗口事件而不是层层传 prop，
  // 与 xiaomo:open-contact 同一套通道。放在 openSettingsTab 之后定义，
  // 避免依赖数组在渲染期碰到还没初始化的 const。
  // detail.toolsTab（可选）进一步指定「工具与扩展」的内部页签，
  // 比如联系人页的「管理技能」要落到技能页而不是总览。
  const [settingsToolsFocus, setSettingsToolsFocus] = useState<{ tab: "overview" | "skills" | "extensions"; seq: number }>(
    () => ({ tab: "overview", seq: 0 }),
  );
  useEffect(() => {
    const openSettings = (event: Event): void => {
      const d = (event as CustomEvent<{ tab?: string; toolsTab?: string }>).detail;
      const tab = d?.tab;
      if (typeof tab !== "string" || tab.length === 0) return;
      if (d?.toolsTab === "overview" || d?.toolsTab === "skills" || d?.toolsTab === "extensions") {
        setSettingsToolsFocus((prev) => ({ tab: d.toolsTab as "overview" | "skills" | "extensions", seq: prev.seq + 1 }));
      }
      openSettingsTab(tab as SettingsTab);
    };
    window.addEventListener("xiaomo:open-settings", openSettings);
    return () => window.removeEventListener("xiaomo:open-settings", openSettings);
  }, [openSettingsTab]);

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
  const titlebarContext = profile
    ? "联系人资料"
    : activeView === "chat" ? "对话"
      : activeView === "status" ? "状态"
        : "设置";
  // 遮罩只挡鼠标，键盘 Tab 仍能溜进身后的会话框——弹窗开着就把整个壳层置为 inert。
  useEffect(() => { if (shellRef.current) shellRef.current.inert = asstShown; }, [asstShown]);

  return (
    <>
    {/* 桌面无边框窗口的页内标题栏（浏览器/手机端渲染为 null）：必须挂在 #shell 之外——
        它是 fixed 定位的窗口级 UI，不该进三栏网格，z 档也要压过弹层。 */}
    <Titlebar context={titlebarContext} />
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
          currentConversation={conversation?.id ?? null}
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
            <SettingsView onChanged={refreshContactMeta} initialTab={settingsTab} navSeq={settingsNavSeq} revealAdvanced={settingsAdvanced} focusProfile={settingsFocusProfile} toolsFocus={settingsToolsFocus} onOwnerAvatar={setOwnerAvatar} loadError={settingsLoadError} onRetryLoad={retrySettings} />
          </div>
        )}
        {(visitedViews.has("chat") || view === "chat") && (
          <div className={"view" + (view === "chat" && !profile ? " active" : "")} id="view-chat">
            {chatOpen ? (
            <ChatView key={current + ":" + (conversation?.id ?? "local")} msgScope={current} conversationId={conversation?.id} conversationTitle={conversation?.title} readOnly={conversation?.readOnly === true} onOpenLocal={() => setConversation(null)}
              conversations={contactConversations} onOpenConversation={openChatConversation}
              focusMessageId={focusMsg} onFocusHandled={() => setFocusMsg(null)}
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
              /* 全站最显眼的空态：当前联系人被归档/删掉后等人自己挑。
                 .chat-blank 只管居中布局（布局类，非旧空态类），内容换成统一 EmptyState。
                 「新建联系人」复用资料页现成的 openContactProfile("create") 入口。 */
              <div className="chat-blank">
                <EmptyState icon={<MessagesSquare size={22} strokeWidth={1.5} />}
                  title="还没有打开会话" hint="从联系人列表里挑一位开始聊天">
                  <button type="button" className="primary sm" onClick={() => openContactProfile("create", "")}>
                    <UserRoundPlus size={14} strokeWidth={1.8} style={{ verticalAlign: -2, marginRight: 6 }} />新建联系人
                  </button>
                </EmptyState>
              </div>
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
      settingsSeq={assistantSettingsSeq}
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
    {/* 全局轻提示：设置保存这类「结果提示」的统一出口（lib/toast.ts）。
        挂在 App 根上，用户保存后立刻切分组/切视图，提示照样看得见。 */}
    <ToastLayer />
    </>
  );
}

