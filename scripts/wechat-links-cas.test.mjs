#!/usr/bin/env node
/**
 * 微信绑定表的并发写回归。
 *
 * 场景：同一台机器开着两个窗口，共用一个库。窗口 A 在「读」和「写」之间，
 * 窗口 B 刚扫了码或刚删了一条绑定。旧实现是读一次、整包覆盖写回——
 * B 那条会凭空消失，A 还会以为自己成功了。
 *
 * 现在写回是条件写（CAS）：原文变了就重读、重新合并、再写一次。
 * 这里不用真并发，而是把「别人恰好在这个空档里写了一次」精确地插进 CAS 那一步。
 *
 * 覆盖：
 * 1. kvSwap 的原子语义（记录不存在 / 原文一致 / 原文已变）；
 * 2. 撞车后重读：另一窗口刚写的行必须留下，本进程的改动也必须在；
 * 3. 撞车后墓碑照样生效：删掉的行不会被库里的旧副本复活；
 * 4. 连续两次撞车 → 退回覆盖写并且不抛错（宁可最后一手生效，不能卡死正在发送的回复）。
 *
 * 运行：node --experimental-sqlite scripts/wechat-links-cas.test.mjs
 */
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";

process.env.DB_PATH = "./data/wechat-links-cas.db";
for (const suffix of ["", "-wal", "-shm"]) rmSync("./data/wechat-links-cas.db" + suffix, { force: true });

const { kvGet, kvSet, kvSwap } = await import("../src/core/db.ts");
const { LinkTable } = await import("../src/channels/wechat.ts");

// 绑定行只需要 id / contactId 两个必填字段：parseLinks 会补全其余字段。
const rowOf = (id, contactId) => ({ id, contactId, baseUrl: "https://ilinkai.weixin.qq.com", enabled: true });

console.log("=== 微信绑定表并发写回归 ===\n");

// ── 1. kvSwap 是原子的 ────────────────────────────────────────
{
  console.log("1. kvSwap：比对与落盘在同一条 SQL 里");
  assert.equal(kvSwap("cas.probe", null, "A"), true, "记录不存在时应当写入成功");
  assert.equal(kvGet("cas.probe"), "A");

  assert.equal(kvSwap("cas.probe", null, "B"), false, "记录已存在：按「新建」写必须失败");
  assert.equal(kvGet("cas.probe"), "A", "失败时不能改动库里的值");

  assert.equal(kvSwap("cas.probe", "A", "C"), true, "原文一致时才允许覆盖");
  assert.equal(kvSwap("cas.probe", "A", "D"), false, "原文已经被改过 → 必须拒绝，这就是拦住丢更新的那道门");
  assert.equal(kvGet("cas.probe"), "C", "被拒绝的写不能落盘");

  kvSet("cas.probe", ""); // 空串也算「有记录」，不能当成不存在
  assert.equal(kvSwap("cas.probe", null, "E"), false, "空串记录也不能被当成「不存在」");
  console.log("   ✓ 新建 / 一致覆盖 / 冲突拒绝 三种情况都对\n");
}

// ── 2. 撞车后重读：两边的行都在 ──────────────────────────────
{
  console.log("2. 写回时撞车 → 重读重合并，谁的行都不丢");
  const store = { value: null };
  let sneak = null;
  let casCalls = 0;
  const links = new LinkTable({
    read: () => store.value,
    write: (value) => { store.value = value; },
    cas: (expected, value) => {
      casCalls += 1;
      if (sneak !== null) {
        // 别的窗口恰好在这个空档里把库改成了 sneak，于是我们手里的原文作废
        store.value = sneak;
        sneak = null;
        return false;
      }
      if (store.value !== expected) return false;
      store.value = value;
      return true;
    },
    limit: 40,
  });

  links.keep(rowOf("a1", "contact-a"));
  sneak = JSON.stringify({ version: 9, links: [rowOf("b1", "contact-b")] });
  links.save();

  const saved = JSON.parse(store.value);
  assert.equal(casCalls, 2, "撞一次车就应当重试一次");
  assert.ok(saved.links.some((row) => row.id === "a1"), "本进程刚绑的那条必须落库");
  assert.ok(saved.links.some((row) => row.id === "b1"), "另一窗口刚写的行不能被抹掉（旧实现就是丢在这里）");
  assert.equal(saved.version, 10, "版本号落在重读后的库版本上 +1");
  assert.ok(links.byId("b1") !== null, "重读之后本进程的视图里也该看得见对方的绑定");
  console.log("   ✓ 两条绑定共存，版本号接着库里的 9 走到 10\n");
}

// ── 3. 撞车后墓碑仍然生效 ────────────────────────────────────
{
  console.log("3. 本进程删掉的行，不会被库里那份旧副本复活");
  const store = { value: null };
  let sneak = null;
  const links = new LinkTable({
    read: () => store.value,
    write: (value) => { store.value = value; },
    cas: (expected, value) => {
      if (sneak !== null) { store.value = sneak; sneak = null; return false; }
      if (store.value !== expected) return false;
      store.value = value;
      return true;
    },
    limit: 40,
  });

  links.keep(rowOf("a1", "contact-a"));
  links.save();

  links.drop("a1");
  // 对方那份副本里 a1 还在（它还没收到这次删除）
  sneak = JSON.stringify({ version: 5, links: [rowOf("a1", "contact-a"), rowOf("b1", "contact-b")] });
  links.save();

  const saved = JSON.parse(store.value);
  assert.ok(!saved.links.some((row) => row.id === "a1"), "删掉的不能被库里的旧副本复活");
  assert.ok(saved.links.some((row) => row.id === "b1"), "对方新加的行仍要留下");
  console.log("   ✓ 墓碑在重试里没有被清掉\n");
}

// ── 4. 连续撞车：退回覆盖写，不抛错 ──────────────────────────
{
  console.log("4. 连续两次撞车 → 覆盖写并 warn，不让发送卡死");
  const store = { value: JSON.stringify({ version: 1, links: [] }) };
  let conflicts = 0;
  const warn = console.warn;
  let warned = "";
  console.warn = (message) => { warned = String(message); };
  const links = new LinkTable({
    read: () => store.value,
    write: (value) => { store.value = value; },
    cas: () => {
      // 永远撞车：模拟对面一个死循环写者
      conflicts += 1;
      store.value = JSON.stringify({ version: 100 + conflicts, links: [rowOf("z" + conflicts, "contact-z")] });
      return false;
    },
    limit: 40,
  });

  links.keep(rowOf("own", "contact-own"));
  links.save();
  console.warn = warn;

  const saved = JSON.parse(store.value);
  assert.equal(conflicts, 2, "只重试一次（共两次 CAS 尝试），不无限循环");
  assert.ok(saved.links.some((row) => row.id === "own"), "兜底覆盖写：自己的改动仍然落库");
  assert.ok(warned.includes("覆盖写入"), "兜底时要留下可诊断的 warn");
  console.log(`   ✓ 两次尝试后兜底，warn=${JSON.stringify(warned.slice(0, 24) + "…")}\n`);
}

// 库文件不在这里删：连接还开着，Windows 上 rmSync 会 EPERM。下次运行开头会先清掉。
console.log("微信绑定表并发写回归：全部通过");
