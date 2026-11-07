// 「工具与扩展」一级分区的容器。
//
// 这一屏把总览 / 技能 / 扩展收进同一套内部页签，并持有唯一的扩展快照：
// 总览的指标与扩展页的清单读的是同一份数据，改完一次两边同时更新，
// 不再各自发请求、各自缓存一份可能互相打架的状态。

import { useCallback, useEffect, useState } from "react";
import Tabs, { panelAria } from "../../components/Tabs";
import TabPanel from "../../components/TabPanel";
import ToolOverviewSection from "./ToolOverviewSection";
import SkillSection from "./SkillSection";
import ExtensionSection from "./ExtensionSection";
import { cachedSnapshot, invalidateSnapshot, loadSnapshot, putSnapshot } from "../../lib/extensionsStore";
import type { ExtensionSnapshot } from "../../types";
import type { SettingsForm } from "./useSettingsForm";

type ToolsTab = "overview" | "skills" | "extensions";

const TOOLS_TABS: Array<{ key: ToolsTab; label: string }> = [
  { key: "overview", label: "总览" },
  { key: "skills", label: "技能" },
  { key: "extensions", label: "扩展" },
];

export default function ToolsWorkbench({ form, ask, focus, onGoModel, onGoCapability, onGoMedia }: {
  form: SettingsForm;
  ask: (title: string, note: string, run: () => void) => void;
  /** 设置搜索命中某个锚点时，把内部页签一起切过去。 */
  focus?: { tab: ToolsTab; seq: number };
  onGoModel: () => void;
  onGoCapability: () => void;
  onGoMedia: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<ToolsTab>("overview");
  const [visited, setVisited] = useState<Set<ToolsTab>>(() => new Set(["overview"]));
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot | null>(() => cachedSnapshot());
  const [loadErr, setLoadErr] = useState("");

  const apply = useCallback((next: ExtensionSnapshot): void => {
    putSnapshot(next);
    setSnapshot(next);
    setLoadErr("");
  }, []);

  const refresh = useCallback((): void => {
    invalidateSnapshot();
    loadSnapshot()
      .then((next) => { setSnapshot(next); setLoadErr(""); })
      .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (cachedSnapshot() === null) refresh();
  }, [refresh]);

  useEffect(() => {
    setVisited((prev) => prev.has(tab) ? prev : new Set(prev).add(tab));
  }, [tab]);

  useEffect(() => {
    if (focus === undefined) return;
    setTab(focus.tab);
    setVisited((prev) => prev.has(focus.tab) ? prev : new Set(prev).add(focus.tab));
  }, [focus]);

  return (
    <div className="tools-workbench">
      <div className="set-subnav">
        <Tabs base="set-tools" value={tab} onChange={setTab} tabs={TOOLS_TABS} />
      </div>

      {loadErr !== "" && (
        <div className="ext-banner is-bad" role="alert">扩展清单没读出来：{loadErr}</div>
      )}

      <TabPanel active={tab === "overview"} aria={panelAria("set-tools", "overview")}>
        <ToolOverviewSection
          form={form}
          onGoModel={onGoModel}
          onGoCapability={onGoCapability}
          onGoMedia={onGoMedia}
          onGoExtensions={() => setTab("extensions")}
        />
      </TabPanel>

      {(visited.has("skills") || tab === "skills") && (
        <TabPanel active={tab === "skills"} aria={panelAria("set-tools", "skills")}>
          <SkillSection ask={ask} />
        </TabPanel>
      )}

      {(visited.has("extensions") || tab === "extensions") && (
        <TabPanel active={tab === "extensions"} aria={panelAria("set-tools", "extensions")}>
          <ExtensionSection ask={ask} snapshot={snapshot} onSnapshot={apply} onRefresh={refresh} />
        </TabPanel>
      )}
    </div>
  );
}
