import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { settingsApi } from "../../api";
import { useExitVisible } from "../../hooks/useExitVisible";
import type { PetSettings } from "../../types";
import { PET_SETTINGS_EVENT } from "./petEvents";
import PetView from "./PetView";

/**
 * 主界面里的桌宠宿主：显示方式 =「桌面端内」时在主窗口挂一只内嵌桌宠。
 * 独立桌面形态不经过这里（main.tsx 按设置直接召唤外壳透明窗，PetView 自取设置）。
 *
 * 设置跟进走 PET_SETTINGS_EVENT 页内事件（useSettingsForm / PetView 保存后广播），
 * 收到后重拉快照——只发信号不带数据，保存点不用各自拼 pet 对象。
 * 浮层 portal 到 body：App 布局里有 backdrop-filter 容器，fixed 后代会被当包含块。
 */
export default function PetHost(): JSX.Element | null {
  const [pet, setPet] = useState<PetSettings | null>(null);
  const show = pet !== null && pet.enabled && pet.displayMode === "in-app";
  const { visible, closing, onAnimationEnd } = useExitVisible(show, "petExit");

  useEffect(() => {
    let disposed = false;
    settingsApi.fetchSettings().then((snap) => {
      if (!disposed) setPet(snap.pet);
    }).catch(() => undefined);
    const onChanged = (): void => {
      settingsApi.fetchSettings().then((snap) => {
        if (!disposed) setPet(snap.pet);
      }).catch(() => undefined);
    };
    window.addEventListener(PET_SETTINGS_EVENT, onChanged);
    return () => {
      disposed = true;
      window.removeEventListener(PET_SETTINGS_EVENT, onChanged);
    };
  }, []);

  if (!visible || !pet) return null;
  return createPortal(
    <div className="pet-inline-host" data-closing={closing || undefined} aria-hidden={closing}
      onAnimationEnd={onAnimationEnd}>
      <PetView variant="inline" externalSettings={pet} />
    </div>,
    document.body,
  );
}
