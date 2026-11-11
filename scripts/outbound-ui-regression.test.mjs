#!/usr/bin/env node
/** 投递队列前端入口回归：用户可见、可重试/忽略；批量运维只在开发模式出现。 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const status = readFileSync("frontend/src/features/status/StatusView.tsx", "utf8");
const queue = readFileSync("frontend/src/features/status/OutboundQueueSection.tsx", "utf8");
const api = readFileSync("frontend/src/api/outbound.ts", "utf8");
const overview = readFileSync("frontend/src/features/status/OverviewSection.tsx", "utf8");

assert(/import OutboundQueueSection/.test(status), "状态页应接入投递队列组件");
assert(/key: "queue", label: "投递队列"/.test(status), "活动记录应有投递队列入口");
assert(/action === "outbound"/.test(status), "运行检查应能跳转到投递队列");
assert(/outboundApi\.list/.test(queue), "队列组件应读取队列 API");
assert(/statClass\("open"\)[\s\S]{0,240}?setStatus\("open"\)/.test(queue)
  && /statClass\("dead"[\s\S]{0,240}?setStatus\("dead"\)/.test(queue), "概况卡应可点击直接筛选待处理 / 死信");
assert(/statClass\("delivered"\)[\s\S]{0,240}?setStatus\("delivered"\)/.test(queue), "已送达卡应能筛选已送达");
assert(/outboundApi\.retry/.test(queue) && /outboundApi\.ignore/.test(queue), "用户应能重试或忽略单条记录");
assert(/devMode &&[\s\S]{0,500}?retryAll\(\)/.test(queue), "批量重试只能在开发模式显示");
assert(/devMode &&[\s\S]{0,500}?purge\(\)/.test(queue), "终态清理只能在开发模式显示");
assert(/export function retryAll/.test(api), "前端 API 应封装开发模式批量重试");
assert(/outbound\.dead/.test(overview), "总览应提示死信数量");

console.log("投递队列前端入口回归：全部通过");
