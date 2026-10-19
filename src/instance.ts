// 同一个库被多个进程打开时（桌面多窗口、`npm run dev` 与桌面端并存），
// 「启动清扫在飞的处理单」「跑主动性定时器」「恢复微信长轮询」「连上 QQ 网关」
// 这四类全局副作用只能有一个进程做——否则第二个进程一启动就把第一个正在跑的轮次标成失败，
// 主动消息还会双发、日配额翻倍。
//
// 协调点是库里的 `instance_lease` 一行（见 db.ts），三条规矩缺一不可：
// 1) **抢占是原子的**：比较与写入在同一条带 WHERE 的 UPSERT 里完成。
//    先读后写的话，两个同时启动的进程都能读到「没有新鲜心跳」，于是双双自认当家。
// 2) **续租带 fencing**：只认 id 是自己的那一行。当家进程卡死超过 STALE_MS 被别人抢走后，
//    它回来续租会拿到 changes=0，于是自己降级——否则两个进程都以为自己是当家，
//    微信长轮询各跑一遍，对端一句话投递两次。
// 3) **交还只删自己的行**：无条件 `DELETE WHERE k=?` 会把已经接手的新当家的租约一起删掉，
//    第三个进程于是又能抢，退化成反复双主。
//
// 从进程还会周期性重试抢占：主窗口关掉后，还活着的窗口能自己补位，
// 而不是界面照常但「她变冷了」（不轮询微信、不跑主动性、不做维护清理）直到重启。

import { db } from "./db.ts";

const KEY = "primary";
const HEARTBEAT_MS = 5_000;
/** 三倍心跳没续上才算死：留足 GC 停顿与磁盘忙时的余量，别把活人当死人。 */
const STALE_MS = HEARTBEAT_MS * 3;

const selfId = `${process.pid}-${Date.now().toString(36)}`;

let primary = false;

/**
 * 一条语句完成「比较 + 抢占」。`at < now - ttl` 才允许覆盖别人；
 * `id = excluded.id` 那半支是给自己续租用（顺带刷新 pid，进程复用同一 id 时也对）。
 * changes=1 就是抢到了——SQLite 的写串行化保证同时抢只有一个赢。
 */
function tryTake(ttlMs: number): boolean {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO instance_lease (k, id, pid, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET id = excluded.id, pid = excluded.pid, at = excluded.at
       WHERE instance_lease.at < ? OR instance_lease.id = excluded.id`,
    )
    .run(KEY, selfId, process.pid, now, now - ttlMs);
  return Number(result.changes) === 1;
}

/** 续租。返回 false = 租约已不归我们（被抢走或行被删），调用方必须降级。 */
function renew(): boolean {
  const result = db.prepare(`UPDATE instance_lease SET at = ? WHERE k = ? AND id = ?`).run(Date.now(), KEY, selfId);
  return Number(result.changes) === 1;
}

/** 抢当主。库里有别人没到期的租约 → 让位，返回 false。 */
export function claimPrimary(): boolean {
  primary = tryTake(STALE_MS);
  return primary;
}

export function isPrimary(): boolean {
  return primary;
}

/**
 * 只读探询：**现在**能不能由本进程跑一次全局副作用（主动性判断这类会把话真的送出去的）。
 *
 * 为什么不能直接用 isPrimary()：那是个缓存标志，只有 claimPrimary() 和心跳循环会置位。
 * 冒烟脚本、一次性 CLI 都是直接 import createHttpServer 起来的，从不走那条路，
 * 于是标志恒为 false——用它当闸门会把"手动检查主动性"在所有非 index.ts 入口上一概拒掉。
 *
 * 判据就是租约本身在仲裁的那件事：没有行、行是自己的、或行已过期 → 可以跑。
 * 与 tryTake 的 WHERE 同口径，但**不写库**（探询不该顺带抢占）。
 */
export function leaseIsFreeOrOurs(): boolean {
  const row = db.prepare(`SELECT id, at FROM instance_lease WHERE k = ?`).get(KEY) as { id: string; at: number } | undefined;
  return !row || row.id === selfId || row.at < Date.now() - STALE_MS;
}

/** 退出时交还主位：下一个启动的实例不必干等租约过期。只删自己那一行。 */
export function releasePrimary(): void {
  primary = false;
  try {
    db.prepare(`DELETE FROM instance_lease WHERE k = ? AND id = ?`).run(KEY, selfId);
  } catch { /* 退出路径上不再抛 */ }
}

/** 当前当家是不是本进程以外的那个；返回它的 pid（自己当家或没人当家时 null），只用于日志。 */
export function primaryPid(): number | null {
  const row = db.prepare(`SELECT id, pid FROM instance_lease WHERE k = ?`).get(KEY) as { id: string; pid: number } | undefined;
  if (!row || row.id === selfId) return null;
  return row.pid || null;
}

/**
 * 心跳循环 = 状态机。在家的拍子续租（fencing 失败就 onLose 降级），
 * 在外的拍子试着抢（抢到就 onGain 补位）。回调只在**状态真的翻转**时调用，
 * 所以调用方可以把「起定时器 / 停定时器」直接挂在上面而不必自己判重。
 */
export function startLeaseLoop(handlers: { onGain: () => void; onLose: () => void }): NodeJS.Timeout {
  const tick = (): void => {
    if (primary) {
      if (renew()) return;
      primary = false;
      console.log(`[instance] 租约被别的进程接走（本进程曾停摆超过 ${Math.round(STALE_MS / 1000)} 秒），降级为只提供界面。`);
      handlers.onLose();
      return;
    }
    if (tryTake(STALE_MS)) {
      primary = true;
      console.log("[instance] 接手当家：开始跑主动性定时器、微信收件与定期维护。");
      handlers.onGain();
    }
  };
  const timer = setInterval(tick, HEARTBEAT_MS);
  timer.unref();
  return timer;
}
