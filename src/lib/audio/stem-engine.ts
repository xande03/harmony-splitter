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

interface BuiltGraph {
  source: AudioBufferSourceNode;
  stemGains: Record<StemId, GainNode>;
  masterGain: GainNode;
}

function chain(ctx: BaseAudioContext, input: AudioNode, nodes: AudioNode[]): AudioNode {
  let current = input;
  for (const node of nodes) {
    current.connect(node);
    current = node;
  }
  return current;
}

function filter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  frequency: number,
  q = 0.9,
  gain = 0,
): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  node.gain.value = gain;
  return node;
}

/**
 * Builds the separation graph. Works both on a live AudioContext and on an
 * OfflineAudioContext (used for the download render), so playback and export
 * always sound identical.
 */
export function buildStemGraph(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  options: GraphOptions,
): BuiltGraph {
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const masterGain = ctx.createGain();
  masterGain.gain.value = options.master;
  masterGain.connect(ctx.destination);

  const isStereo = buffer.numberOfChannels > 1;
  const splitter = ctx.createChannelSplitter(2);
  source.connect(splitter);

  // MID = (L + R) / 2 -> centered content (lead vocal, kick, bass, snare)
  const mid = ctx.createGain();
  const midL = ctx.createGain();
  midL.gain.value = 0.5;
  const midR = ctx.createGain();
  midR.gain.value = 0.5;
  splitter.connect(midL, 0);
  splitter.connect(midR, isStereo ? 1 : 0);
  midL.connect(mid);
  midR.connect(mid);

  // SIDE = (L - R) / 2 -> wide content (guitars, keys, room, backing vox)
  const side = ctx.createGain();
  if (isStereo) {
    const sideL = ctx.createGain();
    sideL.gain.value = 0.5;
    const sideR = ctx.createGain();
    sideR.gain.value = -0.5;
    splitter.connect(sideL, 0);
    splitter.connect(sideR, 1);
    sideL.connect(side);
    sideR.connect(side);
  } else {
    mid.connect(side);
  }

  const stemGains = {} as Record<StemId, GainNode>;
  for (const id of STEM_IDS) {
    const gain = ctx.createGain();
    gain.gain.value = options.levels[id];
    gain.connect(masterGain);
    stemGains[id] = gain;
  }

  // Voz: centro, faixa vocal, presença realçada
  chain(ctx, mid, [
    filter(ctx, "highpass", 190, 0.8),
    filter(ctx, "lowpass", 6200, 0.7),
    filter(ctx, "peaking", 2600, 1.1, 5),
    filter(ctx, "peaking", 420, 1.4, -4),
    stemGains.vocals,
  ]);

  // Baixo: sub e graves centrados
  chain(ctx, mid, [
    filter(ctx, "lowpass", 180, 0.7),
    filter(ctx, "lowpass", 180, 0.7),
    filter(ctx, "highpass", 32, 0.7),
    stemGains.bass,
  ]);

  // Bateria: bumbo (banda grave estreita) + caixa/pratos (agudos)
  chain(ctx, mid, [
    filter(ctx, "bandpass", 85, 1.6),
    filter(ctx, "bandpass", 85, 1.6),
    stemGains.drums,
  ]);
  chain(ctx, mid, [
    filter(ctx, "highpass", 3600, 0.7),
    filter(ctx, "peaking", 7000, 1.0, 4),
    stemGains.drums,
  ]);

  // Violão / guitarra: conteúdo estéreo lateral na faixa média
  chain(ctx, side, [
    filter(ctx, "highpass", 230, 0.8),
    filter(ctx, "lowpass", 5400, 0.7),
    filter(ctx, "peaking", 1400, 1.0, 4),
    stemGains.guitar,
  ]);

  return { source, stemGains, masterGain };
}

export async function renderMix(
  buffer: AudioBuffer,
  options: GraphOptions,
): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(
    2,
    Math.ceil(buffer.duration * buffer.sampleRate),
    buffer.sampleRate,
  );
  const { source } = buildStemGraph(offline, buffer, options);
  source.start(0);
  return offline.startRendering();
}
