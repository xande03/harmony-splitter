export type StemId = "vocals" | "bass" | "drums" | "guitar";

export const STEM_IDS: StemId[] = ["vocals", "bass", "drums", "guitar"];

export type StemLevels = Record<StemId, number>;

export const DEFAULT_LEVELS: StemLevels = {
  vocals: 1,
  bass: 1,
  drums: 1,
  guitar: 1,
};

export interface GraphOptions {
  levels: StemLevels;
  master: number;
}

export interface BuiltGraph {
  sources: Record<StemId, AudioBufferSourceNode>;
  stemGains: Record<StemId, GainNode>;
  analysers: Record<StemId, AnalyserNode>;
  masterGain: GainNode;
  masterAnalyser: AnalyserNode;
}

export function buildStemGraph(
  ctx: BaseAudioContext,
  stems: Record<StemId, AudioBuffer>,
  options: GraphOptions,
): BuiltGraph {
  const masterGain = ctx.createGain();
  masterGain.gain.value = options.master;

  const masterAnalyser = ctx.createAnalyser();
  masterAnalyser.fftSize = 256;
  masterAnalyser.smoothingTimeConstant = 0.5;
  masterGain.connect(masterAnalyser);
  masterAnalyser.connect(ctx.destination);

  const stemGains = {} as Record<StemId, GainNode>;
  const sources = {} as Record<StemId, AudioBufferSourceNode>;
  const analysers = {} as Record<StemId, AnalyserNode>;

  for (const id of STEM_IDS) {
    const source = ctx.createBufferSource();
    source.buffer = stems[id];
    const gain = ctx.createGain();
    gain.gain.value = options.levels[id];
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.45;
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(masterGain);
    sources[id] = source;
    stemGains[id] = gain;
    analysers[id] = analyser;
  }

  return { sources, stemGains, analysers, masterGain, masterAnalyser };
}

export async function renderMix(
  stems: Record<StemId, AudioBuffer>,
  options: GraphOptions,
): Promise<AudioBuffer> {
  const any = stems.vocals;
  const offline = new OfflineAudioContext(
    2,
    Math.ceil(any.duration * any.sampleRate),
    any.sampleRate,
  );
  const { sources } = buildStemGraph(offline, stems, options);
  for (const id of STEM_IDS) sources[id].start(0);
  return offline.startRendering();
}

export async function renderStem(
  buffer: AudioBuffer,
  gain = 1,
): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(
    2,
    buffer.length,
    buffer.sampleRate,
  );
  const source = offline.createBufferSource();
  source.buffer = buffer;
  const g = offline.createGain();
  g.gain.value = gain;
  source.connect(g);
  g.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}
