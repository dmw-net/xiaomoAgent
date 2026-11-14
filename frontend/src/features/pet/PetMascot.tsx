import { useCallback, useEffect, useRef, useState } from "react";
import { animUrl, type PetSkinAssets } from "./petAssets";
import PetMascotSvg from "./PetMascotSvg";

/** 一段动作：loop=true 的动作自己循环；seq 变了就换片段（同名动作连点也要重放）。 */
export type PetAnimSpec = { name: string; loop: boolean; seq: number };

/**
 * 桌宠形象：VP9-alpha 透明 webm 驱动，A/B 双缓冲换动作（dsh-pet 同款）——
 * 新片段装入 BACK 层，canplay 后两层交叉淡入，换动作零黑帧。
 * 素材加载/解码失败时回退内置 SVG 形象（videoFailed 由 PetView 全局收口）。
 *
 * 装载纪律：wantSeq 记最新请求，canplay 时 seq 已过期就丢弃（快速连点不串台）；
 * loadedSeq 记「已经在播的 seq」，effect 重跑（front 翻转引起）时早退防循环。
 */
export default function PetMascot({
  skin,
  anim,
  videoFailed,
  facing = "left",
  onEnded,
  onError,
}: {
  skin: PetSkinAssets;
  anim: PetAnimSpec;
  videoFailed: boolean;
  /** 朝向：追饭等侧身跑动作按它镜像（素材默认朝左，向右跑时水平翻转）。 */
  facing?: "left" | "right";
  onEnded: () => void;
  onError: () => void;
}): JSX.Element {
  const aRef = useRef<HTMLVideoElement | null>(null);
  const bRef = useRef<HTMLVideoElement | null>(null);
  const [front, setFront] = useState<"a" | "b">("a");
  const frontRef = useRef<"a" | "b">("a");
  const wantSeqRef = useRef(anim.seq);
  const loadedSeqRef = useRef<number | null>(null);

  const flipToFront = useCallback((slot: "a" | "b"): void => {
    frontRef.current = slot;
    setFront(slot);
  }, []);

  useEffect(() => {
    if (videoFailed) return;
    if (loadedSeqRef.current === anim.seq) return; // front 翻转引发的 effect 重跑：已经在播这一段
    const backSlot: "a" | "b" = frontRef.current === "a" ? "b" : "a";
    const backEl = (backSlot === "a" ? aRef : bRef).current;
    if (!backEl) return;
    const src = animUrl(skin, anim.name);
    if (!src) return;
    wantSeqRef.current = anim.seq;
    backEl.loop = anim.loop;
    if (backEl.getAttribute("src") !== src) backEl.src = src;
    else backEl.load(); // 同 src（连点同名动作）：强制重来一遍，保住「重放」语义
    const onReady = (): void => {
      if (wantSeqRef.current !== anim.seq) return; // 装载途中又有新动作：这一段丢弃
      loadedSeqRef.current = anim.seq;
      const frontEl = (frontRef.current === "a" ? aRef : bRef).current;
      frontEl?.pause(); // 旧片段定格在淡出帧里（交叉淡入期间）
      flipToFront(backSlot);
      void backEl.play().catch(() => undefined);
    };
    backEl.addEventListener("canplay", onReady);
    return () => backEl.removeEventListener("canplay", onReady);
  }, [anim.loop, anim.name, anim.seq, flipToFront, front, skin, videoFailed]);

  // 零功耗：页面/窗口不可见就暂停解码，可见即恢复（桌面壳 hide / 主窗最小化都会触发）。
  useEffect(() => {
    const onVisible = (): void => {
      const el = (frontRef.current === "a" ? aRef : bRef).current;
      if (!el) return;
      if (document.hidden) el.pause();
      else void el.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  if (videoFailed) return <PetMascotSvg />;
  const cls = (slot: "a" | "b"): string =>
    "pet-mascot-video" + (front === slot ? "" : " is-back") + (facing === "right" ? " is-facing-right" : "");
  return (
    <>
      <video
        ref={aRef}
        className={cls("a")}
        muted
        playsInline
        preload="auto"
        onEnded={() => { if (frontRef.current === "a") onEnded(); }}
        onError={onError}
      />
      <video
        ref={bRef}
        className={cls("b")}
        muted
        playsInline
        preload="auto"
        onEnded={() => { if (frontRef.current === "b") onEnded(); }}
        onError={onError}
      />
    </>
  );
}
