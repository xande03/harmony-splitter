import { Headphones, VolumeX } from "lucide-react";
import type { StemId } from "@/lib/audio/stem-engine";

export interface StemChannelProps {
  id: StemId;
  label: string;
  hint: string;
  icon: React.ReactNode;
  value: number;
  soloed: boolean;
  muted: boolean;
  active: boolean;
  onChange: (value: number) => void;
  onSolo: () => void;
  onMute: () => void;
}

export function StemChannel({
  id,
  label,
  hint,
  icon,
  value,
  soloed,
  muted,
  active,
  onChange,
  onSolo,
  onMute,
}: StemChannelProps) {
  const percent = Math.round(value * 100);

  return (
    <div
      className="stem-card"
      data-stem={id}
      data-dim={!active}
      style={{ ["--stem" as string]: `var(--stem-${id})` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="stem-icon">{icon}</span>
          <div>
            <p className="text-sm font-semibold tracking-tight text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onSolo}
            data-on={soloed}
            className="chip"
            aria-label={`Isolar ${label}`}
            title="Isolar faixa"
          >
            <Headphones className="size-3.5" />
            Solo
          </button>
          <button
            type="button"
            onClick={onMute}
            data-on={muted}
            className="chip"
            aria-label={`Silenciar ${label}`}
            title="Silenciar faixa"
          >
            <VolumeX className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={150}
          value={percent}
          onChange={(event) => onChange(Number(event.target.value) / 100)}
          className="stem-slider"
          aria-label={`Volume de ${label}`}
        />
        <span className="w-12 text-right font-mono text-xs text-muted-foreground">
          {percent}%
        </span>
      </div>

      <div className="stem-meter" aria-hidden>
        <span style={{ width: `${Math.min(100, percent / 1.5)}%` }} />
      </div>
    </div>
  );
}
