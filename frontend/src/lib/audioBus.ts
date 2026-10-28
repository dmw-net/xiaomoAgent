/** 全局只允许一个音频在播：TTS、语音消息与媒体预览共用同一条通道。 */

let active: HTMLAudioElement | null = null;

type Handlers = {
  onEnded?: () => void;
  onError?: () => void;
};

/** 停掉当前播放器；旧元素的 onpause 会负责把自己的组件状态收回。 */
export function stopExclusiveAudio(): void {
  if (!active) return;
  const old = active;
  active = null;
  old.pause();
}

/** 播放一个音频源，自动打断上一条。返回元素供调用方扩展事件。 */
export function playExclusiveAudio(src: string, handlers: Handlers = {}): HTMLAudioElement {
  stopExclusiveAudio();
  const audio = new Audio(src);
  active = audio;
  audio.onended = () => {
    if (active === audio) active = null;
    handlers.onEnded?.();
  };
  audio.onerror = () => {
    if (active === audio) active = null;
    handlers.onError?.();
  };
  void audio.play().catch(() => {
    if (active === audio) active = null;
    handlers.onError?.();
  });
  return audio;
}

export function pauseExclusiveAudio(audio: HTMLAudioElement): void {
  if (active === audio) active = null;
  audio.pause();
}
