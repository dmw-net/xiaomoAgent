import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Captions, Pause, Play } from "lucide-react";
import { pauseExclusiveAudio, playExclusiveAudio } from "../lib/audioBus";

function secondsLabel(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? m + ":" + String(s).padStart(2, "0") : s + "\u2033";
}

function fallbackWaveform(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Array.from({ length: 30 }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const wobble = Math.abs(Math.sin(i * 1.73 + (h >>> 0) / 4294967296)) * 0.48;
    return 0.18 + wobble;
  });
}

function cleanWaveform(input?: number[], seed = ""): number[] {
  const values = Array.isArray(input) ? input.filter((n) => Number.isFinite(n)).slice(0, 64) : [];
  if (values.length >= 8) return values.map((n) => Math.min(1, Math.max(0.08, n)));
  return fallbackWaveform(seed);
}

/** 语音消息气泡：播放/暂停、波形、时长与可选转写；全站同一时间只播一条。 */
export default function VoiceMessageBubble({ url, durationMs, waveform, transcript, compact = false }: {
  url: string;
  durationMs?: number;
  waveform?: number[];
  transcript?: string;
  compact?: boolean;
}): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showText, setShowText] = useState(false);
  const bars = useMemo(() => cleanWaveform(waveform, url), [waveform, url]);
  const duration = Math.max(1000, durationMs ?? 1000);
  const width = Math.max(142, Math.min(compact ? 210 : 250, 116 + (duration / 1000) * 3.2));

  useEffect(() => () => {
    const audio = audioRef.current;
    if (audio) pauseExclusiveAudio(audio);
  }, [url]);

  const toggle = (): void => {
    if (playing && audioRef.current) {
      pauseExclusiveAudio(audioRef.current);
      setPlaying(false);
      return;
    }
    setPlaying(true);
    const audio = playExclusiveAudio(url, {
      onEnded: () => setPlaying(false),
      onError: () => setPlaying(false),
    });
    audioRef.current = audio;
    audio.onplay = () => setPlaying(true);
    audio.onpause = () => setPlaying(false);
  };

  return (
    <div className={"voice-message" + (compact ? " compact" : "")} data-voice-url={url}>
      <div className="voice-row" style={{ "--voice-width": width + "px" } as CSSProperties}>
        <button type="button" className="voice-play" aria-label={playing ? "暂停语音消息" : "播放语音消息"}
          aria-pressed={playing} onClick={(e) => { e.stopPropagation(); toggle(); }}
          onContextMenu={(e) => e.stopPropagation()}>
          {playing ? <Pause size={compact ? 14 : 16} fill="currentColor" /> : <Play size={compact ? 14 : 16} fill="currentColor" />}
        </button>
        <span className="voice-wave" aria-hidden="true">
          {bars.map((v, i) => <i key={i} style={{ height: Math.round(4 + v * (compact ? 14 : 18)) + "px" }} />)}
        </span>
        <span className="voice-duration">{secondsLabel(duration)}</span>
        {transcript && (
          <button type="button" className="voice-text-toggle" aria-label={showText ? "收起语音转写" : "查看语音转写"}
            aria-expanded={showText} title={showText ? "收起文字" : "查看文字"}
            onClick={(e) => { e.stopPropagation(); setShowText((v) => !v); }}
            onContextMenu={(e) => e.stopPropagation()}>
            <Captions size={14} />
          </button>
        )}
      </div>
      {showText && transcript && <div className="voice-transcript">{transcript}</div>}
    </div>
  );
}
