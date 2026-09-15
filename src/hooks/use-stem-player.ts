import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_LEVELS,
  STEM_IDS,
  buildStemGraph,
  renderMix,
  renderStem,
  type StemId,
  type StemLevels,
} from "@/lib/audio/stem-engine";
import { mixPeaks, separateStems, type StemBuffers } from "@/lib/audio/separate";
import { audioBufferToWav } from "@/lib/audio/wav";

function rmsFromAnalyser(node: AnalyserNode | null, scratch: Uint8Array<ArrayBuffer>) {
  if (!node) return 0;
  node.getByteTimeDomainData(scratch);
  let sum = 0;
  for (let i = 0; i < scratch.length; i += 1) {
    const v = ((scratch[i] as number) - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / scratch.length) * 2.4);
}

export function useStemPlayer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const stemsRef = useRef<StemBuffers | null>(null);
  const mixRef = useRef<AudioBuffer | null>(null);
  const sourcesRef = useRef<Record<StemId, AudioBufferSourceNode> | null>(null);
  const stemGainsRef = useRef<Record<StemId, GainNode> | null>(null);
  const analysersRef = useRef<Record<StemId, AnalyserNode> | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const masterAnalyserRef = useRef<AnalyserNode | null>(null);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const meterScratch = useRef(new Uint8Array(128));

  const [levels, setLevels] = useState<StemLevels>({ ...DEFAULT_LEVELS });
  const [master, setMaster] = useState(0.9);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [stemPeaks, setStemPeaks] = useState<Record<StemId, number[]>>({
    vocals: [],
    bass: [],
    drums: [],
    guitar: [],
  });
  const [meters, setMeters] = useState<Record<StemId, number>>({
    vocals: 0,
    bass: 0,
    drums: 0,
    guitar: 0,
  });
  const [masterMeter, setMasterMeter] = useState(0);
  const [splitProgress, setSplitProgress] = useState<{
    ratio: number;
    label: string;
  } | null>(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  const stopSource = useCallback(() => {
    if (sourcesRef.current) {
      for (const id of STEM_IDS) {
        try {
          sourcesRef.current[id].onended = null;
          sourcesRef.current[id].stop();
        } catch {
          /* already stopped */
        }
        try {
          sourcesRef.current[id].disconnect();
        } catch {
          /* */
        }
      }
      sourcesRef.current = null;
    }
    stemGainsRef.current = null;
    analysersRef.current = null;
    masterGainRef.current = null;
    masterAnalyserRef.current = null;
  }, []);

  const startAt = useCallback(
    (offset: number) => {
      const stems = stemsRef.current;
      if (!stems) return;
      const ctx = getCtx();
      void ctx.resume();
      stopSource();

      const graph = buildStemGraph(ctx, stems, { levels, master });
      sourcesRef.current = graph.sources;
      stemGainsRef.current = graph.stemGains;
      analysersRef.current = graph.analysers;
      masterGainRef.current = graph.masterGain;
      masterAnalyserRef.current = graph.masterAnalyser;

      const dur = stems.vocals.duration;
      const safeOffset = Math.max(0, Math.min(offset, dur - 0.05));
      graph.sources.vocals.onended = () => {
        if (sourcesRef.current === graph.sources) {
          setIsPlaying(false);
          offsetRef.current = 0;
          setPosition(0);
        }
      };
      for (const id of STEM_IDS) graph.sources[id].start(0, safeOffset);
      startedAtRef.current = ctx.currentTime - safeOffset;
      offsetRef.current = safeOffset;
      setIsPlaying(true);
    },
    [getCtx, levels, master, stopSource],
  );

  const pause = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && sourcesRef.current) {
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
      setPeaks([]);
      const ctx = getCtx();
      await ctx.resume();
      const decoded = await ctx.decodeAudioData(data.slice(0));
      mixRef.current = decoded;
      setDuration(decoded.duration);
      setPeaks(mixPeaks(decoded));
      setSplitProgress({ ratio: 0, label: "Preparando separação…" });
      const stems = await separateStems(decoded, (ratio, label) => {
        setSplitProgress({ ratio, label });
      });
      stemsRef.current = stems;
      setStemPeaks({
        vocals: mixPeaks(stems.vocals, 96),
        bass: mixPeaks(stems.bass, 96),
        drums: mixPeaks(stems.drums, 96),
        guitar: mixPeaks(stems.guitar, 96),
      });
      setSplitProgress(null);
      setReady(true);
      return decoded;
    },
    [getCtx, stopSource],
  );

  const unload = useCallback(() => {
    stopSource();
    stemsRef.current = null;
    mixRef.current = null;
    setIsPlaying(false);
    setReady(false);
    setDuration(0);
    setPosition(0);
    offsetRef.current = 0;
    setPeaks([]);
  }, [stopSource]);

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const exportMix = useCallback(
    async (fileName: string) => {
      const stems = stemsRef.current;
      if (!stems) return;
      const rendered = await renderMix(stems, { levels, master });
      downloadBlob(
        audioBufferToWav(rendered),
        `${fileName.replace(/\.[^.]+$/, "")} - mix.wav`,
      );
    },
    [levels, master],
  );

  const exportStem = useCallback(async (id: StemId, fileName: string) => {
    const stems = stemsRef.current;
    if (!stems) return;
    const rendered = await renderStem(stems[id], 1);
    downloadBlob(
      audioBufferToWav(rendered),
      `${fileName.replace(/\.[^.]+$/, "")} - ${id}.wav`,
    );
  }, []);

  useEffect(() => {
    const tick = () => {
      const ctx = ctxRef.current;
      if (ctx && sourcesRef.current) {
        setPosition(Math.min(ctx.currentTime - startedAtRef.current, duration));
        const scratch = meterScratch.current;
        const next = {} as Record<StemId, number>;
        for (const id of STEM_IDS) {
          next[id] = rmsFromAnalyser(analysersRef.current?.[id] ?? null, scratch);
        }
        setMeters(next);
        setMasterMeter(rmsFromAnalyser(masterAnalyserRef.current, scratch));
      } else {
        setMeters({ vocals: 0, bass: 0, drums: 0, guitar: 0 });
        setMasterMeter(0);
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
    peaks,
    stemPeaks,
    meters,
    masterMeter,
    splitProgress,
    toggle,
    pause,
    seek,
    applyLevels,
    loadArrayBuffer,
    unload,
    exportMix,
    exportStem,
  };
}
