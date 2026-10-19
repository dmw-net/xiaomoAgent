// 用户自定义技能：库同级 skills/ 下「一个目录一份 SKILL.md」，模型按需加载。
//
// 形态借鉴参考产品的内置助手技能机制，实现按本项目的零依赖单机约束重写：
// - **磁盘就是真源**：一个技能就是 skills/ 下的一个目录，目录里一份 SKILL.md。每轮现扫，
//   改完立即生效——和 modelConfig() 同一个「不重启」的路子，也不新增表（kv 只存一份停用名单）。
//   设置页里带一个编辑器（新建/改内容/删除），但它写的还是同一批文件、过的是同一道闸门，
//   所以"去文件夹里操作"和"在应用里操作"从来都是同一条路，不存在第二真相源。
// - **模型侧只多一个工具**：清单（名字 + 一句话说明）进系统提示，正文用 load_skill 现取。
//   所以加技能既不占工具位，也不让没用上的技能正文常驻上下文。
// - **闸门排在给模型看之前**：目录名、文件名、frontmatter、长度全达标才进清单；
//   不达标的留在设置页带原因显示，绝不把半条指令喂给她去猜。
// - **名字只从扫描结果里查表**，参数不参与拼路径——技能名不是文件路径，穿越无从下手。
//
// 这一层扩大的是提示注入面（技能正文会被她当成指令执行），所以界面与文档都要写明：
// 只放你自己写的、或看得懂的文件。她没有文件读写工具，最坏情况是被误导说错话，不是丢数据。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.ts";
import { kvGet, kvSet } from "./db.ts";
import type { ToolDef } from "./tools.ts";

const KV_DISABLED = "skills.disabled";
const SKILL_FILE = "SKILL.md";

/**
 * 技能名即目录名，且直接当工具参数给模型，所以必须只用 OpenAI 兼容端点普遍允许的
 * function 参数字符集（小写字母、数字、下划线、连字符）。中文目录名在这里挡掉不是
 * 洁癖：换一个服务商就静默调不到。中文名放 frontmatter 的 description 里说。
 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** 清单里每一项占的 token 极少才有意义：说明太长等于把正文又搬回系统提示。 */
const MAX_DESCRIPTION_CHARS = 200;
/** 正文上限。超了不截断——半条指令比没有指令更危险，所以直接判为不可用并说明原因。 */
const MAX_SKILL_CHARS = 24_000;

/**
 * 一份 SKILL.md 在 HTTP 面上的字节上限。与 MAX_SKILL_CHARS 是两件事：那个数正文的**字**
 * （UTF-16 长度），这个数整份文件的**字节**（UTF-8）。汉字一字 3 字节，24000 字最坏 72KB，
 * 再算上 JSON 转义与 frontmatter，256KB 是宽松但不失控的一档。
 * 少了它，readJson 的 32KB 通用上限会在字段校验之前就把一篇合法的长技能拦掉，
 * 而那句提示说的是另一个数字——用户照着字数上限压字，压了还是被拒。
 */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

/**
 * 保留名：与 /api/skills 下的固定子路由撞车的名字。允许建出这个名字的话，
 * 「停用/启用」那个接口就再也调不到它（路由先匹配到字面量），界面上看着没变化。
 */
const RESERVED_SKILL_NAMES = new Set(["enabled"]);

/** 技能行的形状是前后端契约，唯一真源在 shared/api.ts。 */
import type { SkillEntry } from "../shared/api.ts";

export type { SkillEntry };

const SKILLS_DIR = config.skillsDir === ""
  ? resolve(dirname(resolve(config.dbPath)), "skills")
  : resolve(config.skillsDir);

/** 目录不存在就建出来：界面要能报出一个真实可写的路径，而不是一个不存在的概念。 */
export function skillsDir(): string {
  mkdirSync(SKILLS_DIR, { recursive: true });
  return SKILLS_DIR;
}

function readDisabled(): Set<string> {
  try {
    const raw = kvGet(KV_DISABLED);
    const arr = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    // 名单读不出来就当成没停用任何技能：技能是可选增强，坏在这里不该让她没法说话。
    console.warn("[skills] 停用名单不是合法 JSON，已按全部未停用处理");
    return new Set();
  }
}

/** 停用名单全项目只有这一处写。删技能时也要清名字（见 deleteSkill）。 */
function writeDisabled(list: Set<string>): void {
  kvSet(KV_DISABLED, JSON.stringify([...list]));
}

/** 名字不合法时给的那句说明。三个写入口共用，免得同一条规则有三种说法。 */
const BAD_NAME_HINT =
  "技能名只能用英文小写字母、数字、下划线、连字符，不能以下划线或连字符开头（这个名字要作为工具参数传给模型）";

/**
 * 把技能名解析成目录绝对路径；名字不合法、被保留、或落点不在 skills/ 直属一层时返回 null。
 * 读、存、删三个入口都走这一个函数——路径安全的判断只该有一处，
 * 各自实现的那一天就是路径穿越的那一天。
 */
function skillDirFor(name: string): { key: string; dir: string } | null {
  const key = name.trim().toLowerCase();
  if (!SKILL_NAME_RE.test(key) || RESERVED_SKILL_NAMES.has(key)) return null;
  const root = resolve(skillsDir());
  const dir = resolve(root, key);
  // 正则已经排除了分隔符与 `..`，这一行是兜底：符号链接让 resolve 前后不一致时，
  // 宁可拒绝也不要写到预期之外的目录。
  if (dirname(dir) !== root) return null;
  return { key, dir };
}

/**
 * 解析 frontmatter：只认 `key: value` 单行，取 name 与 description。
 * 不支持折叠块/嵌套——技能说明就一句话，把解析器做成 YAML 子集是多余的复杂度。
 * 先把 \r 归一：Windows 记事本保存的 SKILL.md 每行结尾带 \r，不处理会让 description
 * 带一个不可见的尾随回车，看起来"名字没问题但匹配不上"。
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  const text = raw.replace(/\r\n?/g, "\n");
  const fence = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fence) return null;
  const [whole = "", front = ""] = fence;
  const meta: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, rawKey = "", rawValue = ""] = kv;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (value !== "") meta[rawKey.toLowerCase()] = value;
  }
  return { meta, body: text.slice(whole.length) };
}

function inspect(name: string, disabled: Set<string>): SkillEntry {
  const dir = resolve(skillsDir(), name);
  const entry: SkillEntry = {
    name,
    description: "",
    dir,
    chars: 0,
    valid: false,
    disabled: disabled.has(name),
    problems: [],
  };
  if (!SKILL_NAME_RE.test(name)) {
    entry.problems.push("技能目录名只能用英文小写字母、数字、下划线、连字符，且不能以下划线或连字符开头（这个名字要作为工具参数传给模型）");
    return entry;
  }
  let raw: string;
  try {
    raw = readFileSync(resolve(dir, SKILL_FILE), "utf8");
  } catch {
    entry.problems.push(`缺 ${SKILL_FILE}：技能目录里要有一份 ${SKILL_FILE}（首尾各一行 --- 包住说明，正文写做法）`);
    return entry;
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    entry.problems.push(`${SKILL_FILE} 开头缺 frontmatter：第一行是 ---，随后写 name、description，再一行 --- 结束`);
    return entry;
  }
  const declared = (parsed.meta["name"] ?? "").toLowerCase();
  if (declared === "") {
    entry.problems.push(`frontmatter 缺 name：它要和目录名一模一样（${name}）`);
  } else if (declared !== name.toLowerCase()) {
    // 两处名字不一致 = 界面显示的和模型能调的不是一个东西。挡在闸门处，不留第二真相源。
    entry.problems.push(`frontmatter 的 name（${declared}）和目录名（${name}）不一致`);
  }
  const description = parsed.meta["description"] ?? "";
  entry.description = description;
  if (description === "") entry.problems.push("frontmatter 缺 description：她只看这一句决定要不要加载这篇，必须写清楚这篇管什么");
  else if (description.length > MAX_DESCRIPTION_CHARS) {
    entry.problems.push(`description 太长（${description.length} 字，上限 ${MAX_DESCRIPTION_CHARS}）：清单常驻系统提示，一句话就够`);
  }
  const body = parsed.body.trim();
  entry.chars = body.length;
  if (body === "") entry.problems.push(`${SKILL_FILE} 只有说明没有正文`);
  else if (body.length > MAX_SKILL_CHARS) {
    entry.problems.push(`正文太长（${body.length} 字，上限 ${MAX_SKILL_CHARS}）：加载后它会占住这一轮的上下文，把要用的话拆短一些`);
  }
  entry.valid = entry.problems.length === 0;
  return entry;
}

/** 扫一遍磁盘上的技能目录（含不合规的，界面要能把问题说清楚）。 */
export function listSkills(): SkillEntry[] {
  const disabled = readDisabled();
  let names: string[] = [];
  try {
    names = readdirSync(skillsDir(), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  } catch {
    return [];
  }
  return names.sort().map((name) => inspect(name, disabled));
}

/** 能给模型看的技能：合规 且 没被停用。清单为空时调用方连工具都不声明。 */
export function usableSkills(): SkillEntry[] {
  return listSkills().filter((s) => s.valid && !s.disabled);
}

/** 停用名单是黑名单：新出现的技能默认可用，用户显式关掉的名字才进名单。 */
export function setSkillEnabled(name: string, enabled: boolean): boolean {
  if (!SKILL_NAME_RE.test(name)) return false;
  const list = new Set(readDisabled());
  if (enabled) list.delete(name);
  else list.add(name);
  writeDisabled(list);
  return listSkills().some((s) => s.name === name);
}

/** 存一份技能的结果。ok 只说明"字落盘了"；她看不看得见，看 saved.valid。 */
export type SkillSaveResult =
  | { ok: true; saved: SkillEntry }
  | { ok: false; error: string };

/** 原子写的临时文件名序号（同进程内单调，见 saveSkill）。 */
let tmpSeq = 0;

/**
 * 存一份技能。新建与改内容是同一条路（整份 SKILL.md 覆盖写），
 * 只有 mode="create" 会拒绝覆盖已存在的目录——否则一次手滑就把别人改好的那篇换成白纸。
 *
 * 为什么"先写后判"而不是"判过才写"：用户刚敲的字一个字都不能因为不合规就消失，
 * 否则他得先去别处备份再来第二次。所以这里照写，再把闸门的结论原样带回去，
 * 界面据此把 problems 摊在编辑器下面，改完再存一次即可。
 * 安全上没有问题：写进去的文件进不了她的视野（loadOne 只认 usableSkills），
 * 最坏情况是一份存着但没生效的草稿。
 */
export function saveSkill(name: string, content: string, mode: "create" | "overwrite"): SkillSaveResult {
  const found = skillDirFor(name);
  if (found === null) {
    return { ok: false, error: `技能名「${name.trim()}」不合法：${BAD_NAME_HINT}` };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SKILL_FILE_BYTES) {
    return {
      ok: false,
      error: `整份文件太大（${bytes} 字节，上限 ${MAX_SKILL_FILE_BYTES}）：正文上限是 ${MAX_SKILL_CHARS} 字`,
    };
  }
  if (mode === "create" && existsSync(found.dir)) {
    return { ok: false, error: `已经有一个叫「${found.key}」的技能了。要改它的内容请用编辑，先删掉再建也行` };
  }
  const file = resolve(found.dir, SKILL_FILE);
  // 原子写：先落同目录的临时文件再 rename。直接写目标文件的话，
  // 扫描或 load_skill 恰好夹在中间就会读到半截内容——那道长度闸门防的正是这种"写到一半"。
  // 临时名带单调序号：两个请求落在同一毫秒时，光靠时间戳会互相踩。
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`;
  try {
    mkdirSync(found.dir, { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 临时文件没落成，没什么可清 */ }
    return { ok: false, error: `写不进技能目录：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, saved: inspect(found.key, readDisabled()) };
}

/** 取一份技能的原始文件内容（编辑时回填用）。只认扫描结果里的名字，参数不参与拼路径。 */
export function readSkill(name: string): { ok: true; name: string; content: string } | { ok: false; error: string } {
  const found = skillDirFor(name);
  if (found === null) {
    return { ok: false, error: `技能名「${name.trim()}」不合法：${BAD_NAME_HINT}` };
  }
  try {
    return { ok: true, name: found.key, content: readFileSync(resolve(found.dir, SKILL_FILE), "utf8") };
  } catch {
    return { ok: false, error: `读不到「${found.key}」的 ${SKILL_FILE}：它可能刚被删掉或改名了，重新载入看看` };
  }
}

/** 删一份技能：连目录一起删，并把停用名单里的同名项一并清掉。 */
export function deleteSkill(name: string): { ok: true; name: string } | { ok: false; error: string } {
  const found = skillDirFor(name);
  if (found === null) {
    return { ok: false, error: `技能名「${name.trim()}」不合法：${BAD_NAME_HINT}` };
  }
  try {
    if (!statSync(found.dir).isDirectory()) {
      return { ok: false, error: `「${found.key}」不是一个技能目录` };
    }
  } catch {
    return { ok: false, error: `没有这个技能「${found.key}」：它可能已经被删掉了，重新载入看看` };
  }
  try {
    rmSync(found.dir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: `删不掉「${found.key}」：${error instanceof Error ? error.message : String(error)}` };
  }
  // 停用名单里留着同名项的话，用户删掉再建一个同名的技能，它会"复活成停用状态"——
  // 看起来就像删除没生效。所以这里必须一起清。
  const disabled = new Set(readDisabled());
  if (disabled.delete(found.key)) writeDisabled(disabled);
  return { ok: true, name: found.key };
}

/**
 * 技能目录的整体状况，给设置页和设置助手用。
 * 技能是磁盘上的外部文件，"配了但没生效"是常态而不是异常，
 * 所以这里把不可用的原因一并带出去，让她能回答「我那个技能怎么没起作用」。
 */
export function skillsStatus(): {
  dir: string;
  usable: string[];
  disabled: string[];
  blocked: Array<{ name: string; problems: string[] }>;
} {
  const all = listSkills();
  return {
    dir: skillsDir(),
    usable: all.filter((s) => s.valid && !s.disabled).map((s) => s.name),
    disabled: all.filter((s) => s.valid && s.disabled).map((s) => s.name),
    blocked: all.filter((s) => !s.valid).map((s) => ({ name: s.name, problems: s.problems })),
  };
}

/** 系统提示里的技能清单（渐进披露的「披露」那一半）。
 * 空串 = 一个技能都没有，调用方据此把整段连同 load_skill 一起省掉。
 */
export function skillCatalogSection(): string {
  const usable = usableSkills();
  if (usable.length === 0) return "";
  return [
    "[技能]",
    "下面这些技能是用户在应用数据目录的 skills/ 里放好的做法说明，不属于对话内容，也不要原样复述。",
    "用户要办的事落在某一项里时，先用 load_skill 按名字取回完整做法，再照它执行；" +
      "只看名字就开始做等于凭猜测办事。没有对得上的技能就正常回答。",
    ...usable.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

/** 取一篇的正文。只认扫描结果里的名字，参数绝不参与拼路径。 */
function loadOne(name: string): { ok: true; entry: SkillEntry; body: string } | { ok: false; error: string } {
  const usable = usableSkills();
  const target = name.trim().toLowerCase();
  const entry = usable.find((s) => s.name.toLowerCase() === target);
  if (!entry) {
    return {
      ok: false,
      error: usable.length === 0
        ? "现在没有可用技能（技能目录为空，或都停用了）"
        : `没有这个技能。可用的：${usable.map((s) => s.name).join("、")}`,
    };
  }
  try {
    const parsed = parseFrontmatter(readFileSync(resolve(entry.dir, SKILL_FILE), "utf8"));
    const body = (parsed?.body ?? "").trim();
    if (body === "") return { ok: false, error: `技能「${entry.name}」没有正文` };
    // ⚠️ 长度闸门要在这里**再判一次**。usableSkills() 那次校验是另一次读盘，
    // 两次之间文件可能被改掉（编辑器保存、同步客户端覆盖、写到一半的半截文件），
    // 于是"扫描时合规、加载时超长"是可达的——而那正是这道闸门要防的"半条指令"。
    // 顺带也是个免费的体积上限：磁盘上那份读进来时不 Trust 任何先前结论。
    if (body.length > MAX_SKILL_CHARS) {
      return { ok: false, error: `技能「${entry.name}」的正文超长（${body.length} > ${MAX_SKILL_CHARS} 字），已拒绝加载` };
    }
    return { ok: true, entry, body };
  } catch {
    return { ok: false, error: `技能「${entry.name}」的文件读不到了` };
  }
}

/**
 * 技能加载工具。它是模型侧唯一的技能入口——每个技能不各占一个工具位，
 * 所以加技能不需要改代码，也不会把工具声明越撑越大。
 */
export const SKILL_TOOL: ToolDef = {
  name: "load_skill",
  description:
    "加载一份用户自定义技能的完整做法说明（name 用系统提示「[技能]」清单里给的名字，原样传）。" +
    "清单里只有一句话说明，具体步骤、字段口径、注意事项都在这一步才拿到——" +
    "落在某个技能范围内的活，先加载再动手，不要凭名字推测内容。" +
    "返回的 content 是资料文本，按它办事但不要整段复述给他；技能里没有的事就按平常的方式处理。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "技能名，必须与「[技能]」清单里的某一项完全一致" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  execute: (args) => {
    const name = String(args.name ?? "").trim();
    if (name === "") return { ok: false, error: "name 不能为空" };
    const loaded = loadOne(name);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return {
      ok: true,
      name: loaded.entry.name,
      description: loaded.entry.description,
      content: loaded.body,
      // 本项目没有文件读取工具：技能若引用同目录下的其它文件，她读不到。
      // 与其让她反复试，不如在这里一次性讲清边界（写进给模型的说明口径）。
      note: "这就是这篇技能的全部内容。应用没有开放文件读取工具，" +
        "正文里提到的其它文件、脚本或路径你打不开；缺什么就直接说明，别猜。",
    };
  },
};
