import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_LEVELS,
  STEM_IDS,
  buildStemGraph,
  renderMix,
  type StemId,
  type StemLevels,
} from "@/lib/audio/stem-engine";
import { audioBufferToWav } from "@/lib/audio/wav";

export function useStemPlayer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const stemGainsRef = useRef<Record<StemId, GainNode> | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const [levels, setLevels] = useState<StemLevels>({ ...DEFAULT_LEVELS });
  const [master, setMaster] = useState(0.9);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  }, []);

  const stopSource = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.onended = null;
        sourceRef.current.stop();
      } catch {
        /* already stopped */
      }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    stemGainsRef.current = null;
    masterGainRef.current = null;
  }, []);

  const startAt = useCallback(
    (offset: number) => {
      const buffer = bufferRef.current;
      if (!buffer) return;
      const ctx = getCtx();
      void ctx.resume();
      stopSource();

      const graph = buildStemGraph(ctx, buffer, { levels, master });
      sourceRef.current = graph.source;
      stemGainsRef.current = graph.stemGains;
      masterGainRef.current = graph.masterGain;

      const safeOffset = Math.max(0, Math.min(offset, buffer.duration - 0.05));
      graph.source.onended = () => {
        if (sourceRef.current === graph.source) {
          setIsPlaying(false);
          offsetRef.current = 0;
          setPosition(0);
        }
      };
      graph.source.start(0, safeOffset);
      startedAtRef.current = ctx.currentTime - safeOffset;
      offsetRef.current = safeOffset;
      setIsPlaying(true);
    },
    [getCtx, levels, master, stopSource],
  );

  const pause = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && sourceRef.current) {
      offsetRef.current = ctx.currentTime - startedAtRef.current;
    }
    stopSource();
    setIsPlaying(false);
  }, [stopSource]);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else startAt(offsetRef.current);
  }, [isPlaying, pause, startAt]);

  const seek = useCallback(
    (value: number) => {
      offsetRef.current = value;
      setPosition(value);
      if (isPlaying) startAt(value);
    },
    [isPlaying, startAt],
  );

  const setStemLevel = useCallback((id: StemId, value: number) => {
    setLevels((prev) => ({ ...prev, [id]: value }));
    const gain = stemGainsRef.current?.[id];
    if (gain && ctxRef.current) {
      gain.gain.setTargetAtTime(value, ctxRef.current.currentTime, 0.02);
    }
  }, []);

  const setMasterLevel = useCallback((value: number) => {
    setMaster(value);
    const gain = masterGainRef.current;
    if (gain && ctxRef.current) {
      gain.gain.setTargetAtTime(value, ctxRef.current.currentTime, 0.02);
    }
  }, []);

  const applyLevels = useCallback((next: StemLevels, nextMaster: number) => {
    setLevels(next);
    setMaster(nextMaster);
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const id of STEM_IDS) {
      stemGainsRef.current?.[id]?.gain.setTargetAtTime(next[id], ctx.currentTime, 0.02);
    }
    masterGainRef.current?.gain.setTargetAtTime(nextMaster, ctx.currentTime, 0.02);
  }, []);

  const loadArrayBuffer = useCallback(
    async (data: ArrayBuffer) => {
      setReady(false);
      stopSource();
      setIsPlaying(false);
      offsetRef.current = 0;
      setPosition(0);
      const ctx = getCtx();
      const decoded = await ctx.decodeAudioData(data.slice(0));
      bufferRef.current = decoded;
      setDuration(decoded.duration);
      setReady(true);
      return decoded;
    },
    [getCtx, stopSource],
  );

  const unload = useCallback(() => {
    stopSource();
    bufferRef.current = null;
    setIsPlaying(false);
    setReady(false);
    setDuration(0);
    setPosition(0);
    offsetRef.current = 0;
  }, [stopSource]);

  const exportMix = useCallback(async (fileName: string) => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    const rendered = await renderMix(buffer, { levels, master });
    const blob = audioBufferToWav(rendered);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileName.replace(/\.[^.]+$/, "")} - mix.wav`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [levels, master]);

  useEffect(() => {
    const tick = () => {
      const ctx = ctxRef.current;
      if (ctx && sourceRef.current) {
        setPosition(Math.min(ctx.currentTime - startedAtRef.current, duration));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [duration]);

  useEffect(() => () => stopSource(), [stopSource]);

  return {
    levels,
    master,
    isPlaying,
    position,
    duration,
    ready,
    toggle,
    pause,
    seek,
    setStemLevel,
    setMasterLevel,
    applyLevels,
    loadArrayBuffer,
    unload,
    exportMix,
  };
}
