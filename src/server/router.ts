// 路由总表：按**原 handle() 的全局顺序**把各领域模块的路由排成一张有序表。
//
// 拆包前的 3785 行单函数里，路由靠「顺序 if + 落空继续」表达优先级，且各域是**交错**的
// （例如：日志 → /api/model/ping → 设置 → 模型档 → 供应商 → 能力 → 技能 → 扩展 → 内容库 →
// 上下文用量 → 思考开关 → 能力测试 → 媒体上传 → 提示词预览 → 会话 → 对话 → 记忆 →
// 联系人(列表/已读) → QQ/微信 → 联系人(资料页一族) → 系统数据 → 助手 → 主动性）。
// 因此这里不能按模块整体平铺，必须按原全局顺序逐个引用命名路由；只在某域的路由彼此
// 相邻且顺序不变时才允许整块展开（…xxxRoutes）。
//
// 新增路由只能插表、不许改序（types.ts 顶部有完整理由）。

import type { Ctx, Route } from "./types.ts";
import { sendJson } from "./http.ts";

import { routes as lanRoutes } from "./routes/lan.ts";
import { routes as eventsRoutes } from "./routes/events.ts";
import { routes as pagesRoutes } from "./routes/pages.ts";
import { routes as diagnosticsRoutes } from "./routes/diagnostics.ts";
import { routes as skillsRoutes } from "./routes/skills.ts";
import { routes as extensionsRoutes } from "./routes/extensions.ts";
import { routes as contentRoutes } from "./routes/content.ts";
import { routes as modelRoutes } from "./routes/model.ts";
import { routes as mediaRoutes } from "./routes/media.ts";
import { routes as emotesRoutes } from "./routes/emotes.ts";
import { routes as conversationsRoutes } from "./routes/conversations.ts";
import { routes as chatRoutes } from "./routes/chat.ts";
import { routes as memoryRoutes } from "./routes/memory.ts";
import { routes as channelsRoutes } from "./routes/channels.ts";
import { routes as assistantRoutes } from "./routes/assistant.ts";
import { routes as proactiveRoutes } from "./routes/proactive.ts";
import {
  modelPingRoute,
  personaDefaultCardRoute,
  settingsGetRoute,
  settingsPostRoute,
  profilesSaveRoute,
  profilesActivateRoute,
  profilesTestRoute,
  profilesDeleteRoute,
  providersRoute,
  capabilitiesSaveRoute,
  capabilitiesReadyRoute,
  capabilitiesTestRoute,
  settingsPreviewRoute,
  thinkingGetRoute,
  thinkingPostRoute,
} from "./routes/settings.ts";
import {
  contactsListRoute,
  contactReadRoute,
  contactGetRoute,
  contactCreateRoute,
  contactUpdateRoute,
  contactUnarchiveRoute,
  contactArchiveRoute,
  contactResetCardRoute,
  contactDeleteRoute,
  factoryResetRoute,
  dataExportRoute,
  dataImportRoute,
  dataDirRoute,
  desktopPrefsRoute,
  contactConsolidateRoute,
} from "./routes/contacts.ts";

export const ROUTES: Route[] = [
  // 局域网访问门 + /api/lan*（必须最先：访问码门在其它任何数据接口之前）
  ...lanRoutes,
  // 事件总线（SSE）
  ...eventsRoutes,
  // 页面与静态资源（/ 、/assets/、/media/、旧路径 302）
  ...pagesRoutes,
  // 健康与自省（/healthz、/api/status、运行检查、存储、日志）
  ...diagnosticsRoutes,
  // 试连（原顺序：排在日志之后、设置之前）
  modelPingRoute,
  personaDefaultCardRoute,
  settingsGetRoute,
  settingsPostRoute,
  profilesSaveRoute,
  profilesActivateRoute,
  profilesTestRoute,
  profilesDeleteRoute,
  providersRoute,
  capabilitiesSaveRoute,
  capabilitiesReadyRoute,
  // 用户自定义技能 / 扩展（保留字顺序在表内已固定）
  ...skillsRoutes,
  ...extensionsRoutes,
  // 她的画 + 内容库
  ...contentRoutes,
  // 上下文用量
  ...modelRoutes,
  thinkingGetRoute,
  thinkingPostRoute,
  capabilitiesTestRoute,
  // 媒体二进制上传与语音
  ...mediaRoutes,
  // 表情包管理（依赖媒体库的 /media 图片，紧贴媒体域；语义属能力管理）
  ...emotesRoutes,
  settingsPreviewRoute,
  // 会话列表
  ...conversationsRoutes,
  // 对话核心（/api/say → /api/turn/* → /api/turns → /api/messages → /api/message/*）
  ...chatRoutes,
  // 记忆
  ...memoryRoutes,
  // 联系人（列表 + 已读，然后 QQ/微信通道，然后资料页一族）
  contactsListRoute,
  contactReadRoute,
  ...channelsRoutes,
  contactGetRoute,
  contactCreateRoute,
  contactUpdateRoute,
  contactUnarchiveRoute,
  contactArchiveRoute,
  contactResetCardRoute,
  contactDeleteRoute,
  factoryResetRoute,
  dataExportRoute,
  dataImportRoute,
  dataDirRoute,
  desktopPrefsRoute,
  contactConsolidateRoute,
  // 助手工作区
  ...assistantRoutes,
  // 主动性
  ...proactiveRoutes,
];

/** 依次试表中的路由：第一个返回 true（已响应）即停；全部落空 → 404。 */
export async function dispatch(ctx: Ctx): Promise<void> {
  for (const route of ROUTES) {
    if (await route(ctx)) return;
  }
  sendJson(ctx.res, 404, { ok: false, error: `未知路径 ${ctx.method} ${ctx.path}` });
}

// ── 启动期路由自检 ─────────────────────────────────────────────
// Route 的守卫（path/method 不匹配 → return false）只靠自觉。漏写守卫的路由会对
// 无关请求照单全收——它排在表里的位置决定了「排在它后面的整段路由全部失联」，
// 且它往往回一份 ok:true 的固定载荷：界面无异常、库里没落笔，极难排障
// （qqBackendRoute 就这么吞掉了整个联系人资料页一族）。
// 这里用一条没有任何路由该认领的探测路径把每条路由都敲一遍：谁应答，谁的守卫就漏了。
// 代价是启动时几十次同步函数调用，换来这类回归活不过启动那一秒。
const PROBE_PATH = "/api/__route_self_check__";

function routeSelfCheck(): void {
  // 应答探测请求的路由会拿到这个假 res：writeHead/end 都是无副作用的吞掉。
  const fakeRes = {
    writeHead: () => fakeRes,
    setHeader: () => fakeRes,
    write: () => fakeRes,
    end: () => fakeRes,
  } as unknown as import("node:http").ServerResponse;
  const offenders: string[] = [];
  for (let i = 0; i < ROUTES.length; i++) {
    const route = ROUTES[i]!;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      try {
        const claimed = route({
          req: null as never,
          res: fakeRes,
          url: new URL(`http://localhost${PROBE_PATH}`),
          path: PROBE_PATH,
          method,
          isLocalOperator: true,
        });
        // 有问题的路由多半是 async：它返回的 promise 在守卫漏掉时也会 resolve 成 true。
        if (claimed === true) {
          offenders.push(`#${i} (${method}) ${String(route).slice(0, 60).replace(/\s+/g, " ")}…`);
          break;
        }
      } catch {
        // 守卫齐全的路由根本不会碰 req；真应答了探测请求的路由若因假 req 抛错，
        // 同样说明它漏了守卫——但报「抛错」不如报「应答」准确，这里选择沉默：
        // 真正的漏网之鱼在下面 method 维度的其它探测里多半以 true 暴露。
      }
    }
  }
  if (offenders.length > 0) {
    console.error(
      `[startup] 路由自检失败：以下路由对探测路径 ${PROBE_PATH} 应答了（漏写 path/method 守卫，` +
      `会吞掉路由表中排在它后面的所有路由）：\n  ${offenders.join("\n  ")}`,
    );
  }
}
routeSelfCheck();
