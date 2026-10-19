// 更改数据存储位置：把库、media、skills 迁到新目录，并更新 desktop.json 的 DATA_DIR。
//
// 为什么必须"迁移 + 重启"而不能热切：config / db / MEDIA_DIR / SKILLS_DIR 都是模块级、
// import 时求值一次的常量（见 config.ts / db.ts / media.ts / skills.ts）。进程内改不了，
// 只能把数据搬到新位置、把外壳的 DATA_DIR 指过去，下次启动才走新目录。
//
// 库用 node:sqlite 的 backup() 在线拷贝：不关库、不中断当前会话；代价是**重启前的新对话
// 不会带到新位置**——所以迁完前端要立刻引导重启（一键重启）。

import { backup } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { mediaDir } from "./media.ts";
import { skillsDir } from "./skills.ts";

export type MigrateResult = { newDir: string; media: number; skills: number };

/** 递归数一个目录下有多少个文件（迁移动画的回执用）；不存在返回 0。 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(cur, entry.name));
      else n += 1;
    }
  }
  return n;
}

/** 把当前数据（库 + media + skills）迁到 newDir，并更新 desktop.json 的 DATA_DIR。异步（backup 在线拷贝）。 */
export async function migrateDataDir(newDirRaw: string): Promise<MigrateResult> {
  const newDir = resolve(newDirRaw.trim());
  if (newDirRaw.trim() === "") throw new Error("目标目录不能为空");

  const oldDb = resolve(config.dbPath);
  const oldBase = dirname(oldDb); // 现在数据就在库文件旁边
  if (newDir === oldBase) throw new Error("新目录就是当前数据目录，无需迁移");

  // 可写检测：建不出来 / 写不进就早死，别拷一半才失败。
  mkdirSync(newDir, { recursive: true });
  const probe = join(newDir, ".write-test");
  try {
    writeFileSync(probe, "ok");
  } catch {
    throw new Error(`目标目录不可写：${newDir}`);
  }
  rmSync(probe, { force: true });

  // 1) 库：node:sqlite 在线 backup（不关库、不中断会话；产出是完整一致的库文件）。
  await backup(db, join(newDir, basename(oldDb)));

  // 2) media / skills：递归拷（存在且有内容才搬，避免造空目录）。
  let media = 0;
  const oldMedia = mediaDir();
  if (existsSync(oldMedia)) {
    media = countFiles(oldMedia);
    if (media > 0) cpSync(oldMedia, join(newDir, "media"), { recursive: true });
  }
  let skills = 0;
  const oldSkills = skillsDir();
  if (existsSync(oldSkills)) {
    skills = countFiles(oldSkills);
    if (skills > 0) cpSync(oldSkills, join(newDir, "skills"), { recursive: true });
  }

  // 3) 更新 desktop.json 的 DATA_DIR（临时文件 + rename 原子写）；dev/CLI 模式无此文件则跳过。
  if (config.desktopConfigFile !== "") {
    try {
      const obj = JSON.parse(readFileSync(config.desktopConfigFile, "utf8")) as Record<string, unknown>;
      obj.DATA_DIR = newDir;
      const tmp = `${config.desktopConfigFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj, null, 2));
      renameSync(tmp, config.desktopConfigFile);
      // 同一个目录里的纯文本指针：卸载器靠它知道该删哪（外壳启动时也写一次，两处同源）。
      writeFileSync(join(dirname(config.desktopConfigFile), "data-dir.txt"), `${newDir}\n`);
    } catch (error) {
      // 数据已拷过去、只是没指过去——说清楚，别让用户以为没迁。
      throw new Error(`数据已拷贝到 ${newDir}，但更新配置文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { newDir, media, skills };
}
