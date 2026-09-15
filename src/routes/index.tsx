import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Disc3,
  Download,
  Guitar,
  Loader2,
  Mic2,
  Music4,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  UploadCloud,
  Waves,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { StemChannel } from "@/components/studio/StemChannel";
import { Waveform } from "@/components/studio/Waveform";
import { useStemPlayer } from "@/hooks/use-stem-player";
import {
  DEFAULT_LEVELS,
  STEM_IDS,
  type StemId,
  type StemLevels,
} from "@/lib/audio/stem-engine";
import {
  deleteAudio,
  getAudio,
  loadTracks,
  putAudio,
  saveTracks,
  type TrackMeta,
} from "@/lib/storage";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "StemStudio — separe faixas de música no navegador" },
      {
        name: "description",
        content:
          "Envie um MP3 e isole voz, baixo, bateria e violão/guitarra. Ajuste o mix e baixe o resultado, tudo offline.",
      },
      { property: "og:title", content: "StemStudio — separador de faixas" },
      {
        property: "og:description",
        content:
          "Separador de faixas no navegador: isole ou realce voz, baixo, bateria e guitarra.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Studio,
});

const STEM_META: Record<StemId, { label: string; hint: string; icon: React.ReactNode }> = {
  vocals: { label: "Voz", hint: "Vocal principal (centro)", icon: <Mic2 className="size-4" /> },
  bass: { label: "Baixo", hint: "Graves e sub", icon: <Waves className="size-4" /> },
  drums: { label: "Bateria", hint: "Bumbo, caixa e pratos", icon: <Disc3 className="size-4" /> },
  guitar: {
    label: "Violão / Guitarra",
    hint: "Cordas e harmonia",
    icon: <Guitar className="size-4" />,
  },
};

const PRESETS: { name: string; levels: StemLevels }[] = [
  { name: "Mix completo", levels: { vocals: 1, bass: 1, drums: 1, guitar: 1 } },
  { name: "Karaokê", levels: { vocals: 0, bass: 1, drums: 1, guitar: 1 } },
  { name: "Acapella", levels: { vocals: 1.3, bass: 0, drums: 0, guitar: 0 } },
  { name: "Treino de baixo", levels: { vocals: 0.6, bass: 0, drums: 1, guitar: 0.8 } },
  { name: "Treino de guitarra", levels: { vocals: 0.6, bass: 1, drums: 1, guitar: 0 } },
];

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Studio() {
  const player = useStemPlayer();
  const [tracks, setTracks] = useState<TrackMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [baseLevels, setBaseLevels] = useState<StemLevels>({ ...DEFAULT_LEVELS });
  const [masterLevel, setMasterLevel] = useState(0.9);
  const [solo, setSolo] = useState<StemId[]>([]);
  const [muted, setMuted] = useState<StemId[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"loading" | "exporting" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTracks(loadTracks());
  }, []);

  const effectiveLevels = useMemo(() => {
    const anySolo = solo.length > 0;
    const next = {} as StemLevels;
    for (const id of STEM_IDS) {
      const silenced = muted.includes(id) || (anySolo && !solo.includes(id));
      next[id] = silenced ? 0 : baseLevels[id];
    }
    return next;
  }, [baseLevels, muted, solo]);

  const { applyLevels } = player;
  useEffect(() => {
    applyLevels(effectiveLevels, masterLevel);
  }, [applyLevels, effectiveLevels, masterLevel]);

  const persist = useCallback((next: TrackMeta[]) => {
    setTracks(next);
    saveTracks(next);
  }, []);

  // Salva o mix da faixa atual
  useEffect(() => {
    if (!currentId) return;
    const timer = window.setTimeout(() => {
      setTracks((prev) => {
        const next = prev.map((t) =>
          t.id === currentId ? { ...t, levels: baseLevels, master: masterLevel } : t,
        );
        saveTracks(next);
        return next;
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [baseLevels, masterLevel, currentId]);

  const openTrack = useCallback(
    async (track: TrackMeta) => {
      setBusy("loading");
      try {
        const data = await getAudio(track.id);
        if (!data) {
          toast.error("Áudio não encontrado no dispositivo.");
          return;
        }
        await player.loadArrayBuffer(data);
        setCurrentId(track.id);
        setBaseLevels({ ...DEFAULT_LEVELS, ...track.levels });
        setMasterLevel(track.master ?? 0.9);
        setSolo([]);
        setMuted([]);
      } catch {
        toast.error("Não foi possível abrir esta música.");
      } finally {
        setBusy(null);
      }
    },
    [player],
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!/audio\/(mpeg|mp3)|\.mp3$/i.test(`${file.type} ${file.name}`)) {
        toast.error("Envie um arquivo MP3.");
        return;
      }
      setBusy("loading");
      try {
        const data = await file.arrayBuffer();
        const decoded = await player.loadArrayBuffer(data);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await putAudio(id, data);
        const meta: TrackMeta = {
          id,
          name: file.name,
          size: file.size,
          duration: decoded.duration,
          createdAt: Date.now(),
          levels: { ...DEFAULT_LEVELS },
          master: 0.9,
        };
        persist([meta, ...loadTracks()]);
        setCurrentId(id);
        setBaseLevels({ ...DEFAULT_LEVELS });
        setMasterLevel(0.9);
        setSolo([]);
        setMuted([]);
        toast.success("Faixas separadas e prontas para o mix.");
      } catch {
        toast.error("Não consegui ler este MP3.");
      } finally {
        setBusy(null);
      }
    },
    [persist, player],
  );

  const removeTrack = useCallback(
    async (track: TrackMeta) => {
      await deleteAudio(track.id);
      persist(loadTracks().filter((t) => t.id !== track.id));
      if (currentId === track.id) {
        player.unload();
        setCurrentId(null);
      }
    },
    [currentId, persist, player],
  );

  const currentTrack = tracks.find((t) => t.id === currentId) ?? null;

  const handleExport = useCallback(async () => {
    if (!currentTrack) return;
    setBusy("exporting");
    try {
      await player.exportMix(currentTrack.name);
      toast.success("Download do seu mix iniciado.");
    } catch {
      toast.error("Falha ao gerar o arquivo.");
    } finally {
      setBusy(null);
    }
  }, [currentTrack, player]);

  return (
    <div className="min-h-screen">
      <Toaster position="top-center" />
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-primary/15 text-primary">
            <AudioLines className="size-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold">
              Stem<span className="brand-text">Studio</span>
            </h1>
            <p className="text-xs text-muted-foreground">
              Separador de faixas — 100% no seu navegador
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => inputRef.current?.click()}
        >
          <UploadCloud className="size-4" />
          Enviar MP3
        </button>
      </header>

      <input
        ref={inputRef}
        type="file"
        accept="audio/mpeg,.mp3"
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <main className="mx-auto grid max-w-6xl gap-6 px-5 pb-20 lg:grid-cols-[1fr_320px]">
        <section className="space-y-6">
          {!currentTrack && (
            <div
              className="dropzone flex flex-col items-center justify-center gap-4 px-6 py-16 text-center"
              data-active={dragging}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void handleFiles(e.dataTransfer.files);
              }}
            >
              <span className="grid size-14 place-items-center rounded-2xl bg-primary/15 text-primary">
                {busy === "loading" || player.splitProgress ? (
                  <Loader2 className="size-6 animate-spin" />
                ) : (
                  <Music4 className="size-6" />
                )}
              </span>
              <div>
                <h2 className="text-xl font-semibold">Arraste sua música aqui</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Solte um arquivo MP3 e ele será dividido em voz, baixo, bateria e
                  violão/guitarra para você isolar ou realçar cada parte.
                </p>
                {player.splitProgress && (
                  <div className="mx-auto mt-4 w-full max-w-sm">
                    <p className="text-xs text-primary">
                      {player.splitProgress.label}{" "}
                      {Math.round(player.splitProgress.ratio * 100)}%
                    </p>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${player.splitProgress.ratio * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => inputRef.current?.click()}
              >
                <UploadCloud className="size-4" />
                Escolher arquivo
              </button>
            </div>
          )}

          {currentTrack && (
            <>
              <div className="panel p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold">{currentTrack.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {player.splitProgress
                        ? `${player.splitProgress.label} ${Math.round(player.splitProgress.ratio * 100)}%`
                        : `${formatTime(player.duration)} · separação espectral no navegador`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setBaseLevels({ ...DEFAULT_LEVELS });
                        setSolo([]);
                        setMuted([]);
                        setMasterLevel(0.9);
                      }}
                    >
                      <RotateCcw className="size-4" />
                      Resetar
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void handleExport()}
                      disabled={busy === "exporting"}
                    >
                      {busy === "exporting" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      Baixar mix
                    </button>
                  </div>
                </div>

                <div className="mt-5 flex items-center gap-4">
                  <button
                    type="button"
                    onClick={player.toggle}
                    className="btn btn-primary size-12 !rounded-full !p-0"
                    aria-label={player.isPlaying ? "Pausar" : "Reproduzir"}
                    disabled={!player.ready}
                  >
                    {player.isPlaying ? (
                      <Pause className="size-5" />
                    ) : (
                      <Play className="size-5" />
                    )}
                  </button>
                  <div className="flex-1">
                    <Waveform
                      peaks={player.peaks}
                      progress={player.duration ? player.position / player.duration : 0}
                      onSeek={(ratio) => player.seek(ratio * player.duration)}
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(player.duration, 0.1)}
                      step={0.01}
                      value={player.position}
                      onChange={(e) => player.seek(Number(e.target.value))}
                      className="master-slider mt-2 w-full"
                      aria-label="Posição da música"
                    />
                    <div className="mt-1 flex justify-between font-mono text-xs text-muted-foreground">
                      <span>{formatTime(player.position)}</span>
                      <span>{formatTime(player.duration)}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.min(100, player.masterMeter * 100)}%` }}
                  />
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <span className="w-28 text-xs font-semibold text-muted-foreground">
                    Volume geral
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={120}
                    value={Math.round(masterLevel * 100)}
                    onChange={(e) => setMasterLevel(Number(e.target.value) / 100)}
                    className="master-slider"
                    aria-label="Volume geral"
                  />
                  <span className="w-12 text-right font-mono text-xs text-muted-foreground">
                    {Math.round(masterLevel * 100)}%
                  </span>
                </div>

              </div>

              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setBaseLevels(preset.levels);
                      setSolo([]);
                      setMuted([]);
                    }}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {STEM_IDS.map((id) => (
                  <StemChannel
                    key={id}
                    id={id}
                    label={STEM_META[id].label}
                    hint={STEM_META[id].hint}
                    icon={STEM_META[id].icon}
                    value={baseLevels[id]}
                    meter={player.meters[id] ?? 0}
                    peaks={player.stemPeaks[id] ?? []}
                    progress={player.duration ? player.position / player.duration : 0}
                    soloed={solo.includes(id)}
                    muted={muted.includes(id)}
                    active={effectiveLevels[id] > 0}
                    onChange={(value) =>
                      setBaseLevels((prev) => ({ ...prev, [id]: value }))
                    }
                    onSolo={() =>
                      setSolo((prev) =>
                        prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
                      )
                    }
                    onMute={() =>
                      setMuted((prev) =>
                        prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
                      )
                    }
                  />
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="panel h-fit p-5">
          <h2 className="text-sm font-semibold">Minhas músicas</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Salvas apenas neste dispositivo.
          </p>
          <div className="mt-4 space-y-2">
            {tracks.length === 0 && (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                Nenhuma música enviada ainda.
              </p>
            )}
            {tracks.map((track) => (
              <div
                key={track.id}
                data-active={track.id === currentId}
                className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 data-[active=true]:border-primary/60"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void openTrack(track)}
                >
                  <p className="truncate text-xs font-medium">{track.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatTime(track.duration)} · {(track.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => void removeTrack(track)}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                  aria-label={`Remover ${track.name}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}
