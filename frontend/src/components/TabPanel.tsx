import type { ReactNode } from "react";
import type { PanelAria } from "./Tabs";

/** 访问过的 tab 面板保活：只隐藏，不卸载。切换保留滚动、筛选、表单与已加载页。 */
export default function TabPanel({ active, aria, children, className = "" }: {
  active: boolean;
  aria: PanelAria;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={"tab-panel" + (active ? " active" : "") + (className ? " " + className : "")}
      hidden={!active} {...aria}>
      {children}
    </div>
  );
}
