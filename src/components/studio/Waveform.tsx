interface WaveformProps {
  peaks?: number[];
  progress?: number;
  onSeek?: (ratio: number) => void;
  color?: string;
  height?: number;
}

export function Waveform({
  peaks,
  progress = 0,
  onSeek,
  color = "var(--color-primary)",
  height = 72,
}: WaveformProps) {
  const bars =
    Array.isArray(peaks) && peaks.length ? peaks : Array.from({ length: 80 }, () => 0.08);

  return (
    <div
      className="waveform"
      style={{ height }}
      onClick={(event) => {
        if (!onSeek) return;
        const rect = event.currentTarget.getBoundingClientRect();
        onSeek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
      }}
      role={onSeek ? "slider" : undefined}
    >
      <div className="waveform-track">
        {bars.map((p, i) => (
          <span
            key={i}
            className="waveform-bar"
            data-played={i / bars.length <= progress}
            style={{
              height: `${Math.max(6, p * 100)}%`,
              background: color,
            }}
          />
        ))}
      </div>
    </div>
  );
}
