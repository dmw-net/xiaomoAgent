// 设置页「技能」分区。技能的真源是磁盘目录（skills/ 下一个目录一份 SKILL.md），
// 这一屏让它不必离开应用：新建 / 改内容 / 删除写下去的都是同一批文件。
//
// 两个刻意的选择：
//   1. 编辑器给的是**原文**，不是拆开的 name/description/正文三个框。frontmatter 就两行，
//      拆表单得来的"友好"会让回填变样（未知键丢失、CRLF 被改写），而原文编辑是无损的。
//   2. 校验不在这里做第二遍。落盘后后端跑的就是扫磁盘那一套 inspect()，problems 原样
//      返回来摊在编辑器下面——界面上抄一份规则，迟早和磁盘上那份说法不一。
//
// 所以"去文件夹里操作"和"在应用里操作"从来是同一条路：同一个目录、同一道闸门、同样即时生效。

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { skillsApi } from "../../api";
import type { SkillEntry, SkillWriteResult } from "../../types";
import { revealInFolder } from "../../lib/reveal-folder";

/** SKILL.md 的文件名。写死在注释里不如让界面照着说，故单独一个常量。 */
const SKILL_FILE = "SKILL.md";

/**
 * 一份合格的 SKILL.md 长什么样。界面里给样本不是啰嗦：校验闸门严格
 * （目录名、name 一致、description 长度、正文长度都会拦），没有样本用户只能靠猜。
 */
const TEMPLATE = (name: string): string[] => [
  "---",
  `name: ${name}`,
  "description: ",
  "---",
  "",
  "正文写具体做法：先确认什么、哪几种情况直接说不知道、语气怎么把握。",
  "写得像给同事的交接说明，不是写给程序的注释。",
];

/** 三态：可用 / 已停用 / 没生效。后者必须在界面上出现，否则用户只会觉得"放了没用"。 */
function stateOf(s: SkillEntry): { label: string; on: boolean } {
  if (!s.valid) return { label: "没生效", on: false };
  return s.disabled ? { label: "已停用", on: false } : { label: "可用", on: true };
}

/** 哪一份正在编辑器里。create 的名字还等着用户起，edit 的名字就是目录名。 */
type Editor = { mode: "create" } | { mode: "edit"; name: string };

export default function SkillSection({ ask }: {
  /** 危险操作确认（删技能）。与应用内删消息/删画同一套居中弹窗，不用 window.confirm。 */
  ask: (title: string, note: string, run: () => void) => void;
}): JSX.Element {
  const [dir, setDir] = useState("");
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  /** 新建时用户起的目录名（小写化后就是 frontmatter 里的 name）。 */
  const [name, setName] = useState("");
  /** 编辑器里的 SKILL.md 原文。 */
  const [content, setContent] = useState("");
  /** 原文还没被手改过：这时名字一换，模板里的 name: 跟着换；改过了就绝不回写。 */
  const [pristine, setPristine] = useState(true);
  /** 上一次保存没过闸门的原因。编辑器开着时才显示。 */
  const [problems, setProblems] = useState<string[]>([]);

  const apply = (data: { dir: string; skills: SkillEntry[] }): void => {
    setDir(data.dir);
    setSkills(data.skills);
    setErr("");
  };

  const load = useCallback((): void => {
    setBusy("scan");
    skillsApi.listSkills()
      .then(apply)
      .catch(fail)
      .finally(() => setBusy(""));
  }, []);

  useEffect(() => { load(); }, [load]);

  /** 出错就把成功那条收掉：两条一起摆着，用户分不清说的是哪一次。 */
  const fail = (e: unknown): void => {
    setNote("");
    setErr(e instanceof Error ? e.message : String(e));
  };

  /** 在系统文件管理器里露出技能目录。失败（浏览器里没有外壳）要说出路径还在屏幕上。 */
  const openDir = (): void => {
    if (dir === "") return;
    setBusy("open");
    revealInFolder(dir)
      .then((r) => { if (!r.ok) fail(new Error(r.error)); })
      .catch(fail)
      .finally(() => setBusy(""));
  };

  const startCreate = (): void => {
    setEditor({ mode: "create" });
    setName("");
    setContent(TEMPLATE("").join("\n"));
    setPristine(true);
    setProblems([]);
    setErr("");
  };

  const startEdit = (skillName: string): void => {
    setEditor({ mode: "edit", name: skillName });
    setProblems([]);
    setErr("");
    // busy 用 "load" 而不是技能名：编辑器据此禁用文本框，免得原文还没回来时
    // 用户敲的字被随后的回填覆盖掉。
    setBusy("load");
    skillsApi.getSkillContent(skillName)
      .then((r) => setContent(r.content))
      .catch((e: unknown) => { fail(e); setEditor(null); })
      .finally(() => setBusy(""));
  };

  const onNameChange = (raw: string): void => {
    const next = raw.trim().toLowerCase();
    setName(next);
    // 只在他还没碰过原文时同步 name: 那一行——少一次"忘了填 name"的报错。
    // 一旦手改过就完全交给用户，绝不往回改写他敲的字。
    if (pristine) setContent(TEMPLATE(next).join("\n"));
  };

  const save = (): void => {
    if (editor === null) return;
    setBusy("save");
    setErr("");
    const done = (data: SkillWriteResult): void => {
      apply(data);
      const saved = data.saved;
      if (saved === undefined) {
        setErr("保存结果里没有这一份，重新载入看看");
        return;
      }
      if (saved.valid) {
        setProblems([]);
        setNote(`「${saved.name}」存好了，下一轮对话就照这篇办。`);
        setEditor(null);
        return;
      }
      // 字已经落盘，只是没过闸门。编辑器留着、问题摊在下面，改完再存一次即可。
      setProblems(saved.problems.length > 0 ? saved.problems : ["后端没给出原因，重新载入看看"]);
      // 新建的那份已经在磁盘上了：再点保存必须走覆盖写，否则会被"已存在"挡回来。
      if (editor.mode === "create") setEditor({ mode: "edit", name: saved.name });
    };
    const call = editor.mode === "create"
      ? skillsApi.createSkill(name, content)
      : skillsApi.updateSkill(editor.name, content);
    call.then(done).catch(fail).finally(() => setBusy(""));
  };

  const toggle = (skillName: string, enabled: boolean): void => {
    setBusy(skillName);
    skillsApi.setSkillEnabled(skillName, enabled)
      .then(apply)
      .catch(fail)
      .finally(() => setBusy(""));
  };

  const remove = (s: SkillEntry): void => {
    ask(`删掉「${s.name}」？`, `技能目录连 ${SKILL_FILE} 一起删掉，找不回来。删完下一轮对话就看不到这篇了。`, () => {
      setBusy(s.name);
      setErr("");
      skillsApi.deleteSkill(s.name)
        .then((data) => {
          apply(data);
          setNote(`「${data.deleted ?? s.name}」已经删掉了。`);
          // 正编辑到一半的那份被删了：留着编辑器只会指向一个不存在的文件。
          if (editor !== null && editor.mode === "edit" && editor.name === s.name) setEditor(null);
        })
        .catch(fail)
        .finally(() => setBusy(""));
    });
  };

  // 可用的排前面，坏技能排后面：一屏进来先看到她现在真能用什么。
  const ordered = [...skills]
    .sort((a, b) => (Number(b.valid) - Number(a.valid)) || a.name.localeCompare(b.name));

  return (
    <div className="section">
      <h2>技能</h2>
      <div className="desc">
        在技能目录里放一份说明，联系人就多会一件事。平时只看到每篇的一句话，
        真要办那件事才取完整内容看。文件改完马上生效。
      </div>

      {err && (
        <div className="banner show bad" role="alert"><div className="body">{err}</div></div>
      )}
      {note !== "" && (
        <div className="banner show ok" role="status"><div className="body">{note}</div></div>
      )}

      <div className="card card-pad">
        <div className="subhead">技能目录</div>
        <div className="hint">
          一个技能就是这个目录下的一个文件夹。在这里新建、改、删，和你自己进这个目录
          放文件夹是一回事——文件落地即生效，不用重启。
        </div>
        <div className="preview show"><pre>{dir === "" ? "正在读取目录…" : dir}</pre></div>
        <div className="actions">
          <button type="button" className="btn sm" onClick={load} disabled={busy !== ""}>
            <RefreshCw size={13} /> {busy === "scan" ? "扫描中…" : "重新扫描"}
          </button>
          <button type="button" className="btn sm" onClick={openDir} disabled={busy !== "" || dir === ""}>
            <FolderOpen size={13} /> {busy === "open" ? "打开中…" : "打开技能目录"}
          </button>
          <button type="button" className="primary sm" onClick={startCreate} disabled={busy !== ""}>
            <Plus size={13} /> 新建技能
          </button>
        </div>
      </div>

      {editor !== null && (
        <div className="card card-pad">
          <div className="subhead">
            {editor.mode === "create" ? "新建技能" : `编辑「${editor.name}」`}
          </div>

          {editor.mode === "create" && (
            <div className="field">
              <label htmlFor="skill-new-name">技能名</label>
              <input id="skill-new-name" value={name} placeholder="weather-advice"
                onChange={(e) => onNameChange(e.target.value)} disabled={busy === "save"} />
              <div className="hint">
                英文小写字母、数字、下划线、连字符，不能以 _ 或 - 开头。它就是目录名，
                也是取回这篇时按名字叫的那个，起完就别再改。
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="skill-editor">{SKILL_FILE} 内容</label>
            <textarea id="skill-editor" className="pf-editor mono" rows={14} spellCheck={false}
              value={content} onChange={(e) => { setContent(e.target.value); setPristine(false); }}
              disabled={busy === "save" || busy === "load"} />
            <div className="hint">
              开头两行 --- 之间：<b>name</b> 和目录名一模一样；<b>description</b> 一句话说明
              什么时候该用这篇（200 字内）。之后是正文，24000 字内。
            </div>
          </div>

          {problems.length > 0 && (
            <div className="banner show bad" role="alert"><div className="body">
              <b>存是存下来了，但这份还进不了联系人的视野：</b>
              {problems.map((p) => <div key={p}>· {p}</div>)}
            </div></div>
          )}

          <div className="actions">
            <button type="button" className="primary sm" onClick={save} disabled={busy === "save"}>
              {busy === "save" ? "保存中…" : "保存"}
            </button>
            <button type="button" className="btn sm" onClick={() => setEditor(null)} disabled={busy === "save"}>
              收起
            </button>
          </div>
        </div>
      )}

      {skills.length === 0 ? (
        <div className="empty">
          还没有技能。点上面的「新建技能」写一份就行；想自己动手的话，
          照着这个路径进目录放一个文件夹、放一份 {SKILL_FILE} 也一样。
        </div>
      ) : ordered.map((s) => {
        const st = stateOf(s);
        return (
          <div className="card card-pad" key={s.name}>
            <div className="cap-head">
              <div>
                <div className="subhead">{s.name}</div>
                {s.description !== "" && <div className="hint">{s.description}</div>}
              </div>
              <span className={"cap-state " + (st.on ? "on" : "off")}>{st.label}</span>
            </div>

            {s.valid ? (
              <div className="preset-row cap-pro-row">
                <label className="cap-enable">
                  <input type="checkbox" checked={!s.disabled} disabled={busy !== ""}
                    onChange={(e) => toggle(s.name, e.target.checked)} />
                  启用
                </label>
                <div className="skill-acts">
                  <button type="button" className="btn sm" onClick={() => startEdit(s.name)}
                    disabled={busy !== ""}>
                    <Pencil size={13} /> 编辑
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => remove(s)}
                    disabled={busy !== ""}>
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            ) : (
              // 不合规的技能没得开关：它根本没进她的视野，给个勾等于骗人说勾上就能用。
              <>
                <div className="hint">
                  {s.problems.map((p) => <div key={p}>· {p}</div>)}
                </div>
                <div className="preset-row cap-pro-row">
                  <div className="skill-acts">
                    <button type="button" className="btn sm" onClick={() => startEdit(s.name)}
                      disabled={busy !== ""}>
                      <Pencil size={13} /> 打开改改
                    </button>
                    <button type="button" className="btn sm ghost" onClick={() => remove(s)}
                      disabled={busy !== ""}>
                      <Trash2 size={13} /> 删除
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}

      <details className="card card-pad">
        <summary className="subhead">{SKILL_FILE} 怎么写</summary>
        <div className="preview show"><pre>{TEMPLATE("weather-advice").join("\n")}</pre></div>
        <div className="hint">
          开头两行 --- 之间：<b>name</b> 和目录名一致；<b>description</b> 一句话说明联系人什么时候该用这篇（200 字内）。
          目录名用英文小写；正文 24000 字内。
        </div>
        <div className="hint">
          技能内容等于你给联系人的指令——只放你自己写的、或看得懂的文件。
        </div>
      </details>
    </div>
  );
}
