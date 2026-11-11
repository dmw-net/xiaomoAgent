// 路由契约：每个领域模块导出一组 Route，router.ts 按声明的顺序排成一张表。
//
// 为什么返回 boolean 而不是直接 return：这张**有序表**是路由优先级的唯一事实来源
// （/api/skills/enabled 必须先于 <name>、扩展保留字必须先于 id、
// /api/turn/* 前缀必须先于 /api/turns/recent）——顺序写错一个，保留字就会
// 开始吃路径参数，所以新增路由只能插表、不许改序。
//
// 约定：
// - 返回 true = 这条路由已经响应，不再继续；
// - 返回 false = 不是这条路由（块整体不匹配，或块内的子分支都没接住），继续往后试。
//   子分支接不住就落空，是**既有语义**（例如 GET /api/lan/rotate 落空到下一个路由），
//   改动必须原样保留，不能顺手「修正」。

import type { IncomingMessage, ServerResponse } from "node:http";

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  /** 只有 /api/lan* 那一组会用到：换绑监听地址（响应写完后再动 socket，见 routes/lan.ts）。 */
  rebind?: () => Promise<{ ok: boolean; error: string }>;
  /** 本机操作者（回环来源 + 本机 Host）：只有 /api/lan* 那一组消费（前导算好传进来）。 */
  isLocalOperator: boolean;
};

export type Route = (ctx: Ctx) => Promise<boolean> | boolean;
