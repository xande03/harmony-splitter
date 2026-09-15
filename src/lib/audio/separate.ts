// @ts-nocheck
import { fft, hann } from "./fft";
import type { StemId } from "./stem-engine";

export type StemBuffers = Record<StemId, AudioBuffer>;

export type SeparateProgress = (ratio: number, label: string) => void;

const NFFT = 2048;
const HOP = 512;
const EPS = 1e-8;
const GAMMA = 2.15;
const STEMS: StemId[] = ["vocals", "bass", "drums", "guitar"];

function yieldThread() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function median3(a: number, b: number, c: number) {
  if (a > b) {
    if (b > c) return b;
    return a > c ? c : a;
  }
  if (a > c) return a;
  return b > c ? c : b;
}

/**
 * Isolation closer to karaoke/stem mixers:
 * mid/side + harmonic/percussive + L/R coherence + Wiener-like masks.
 * Dominant source per bin is sharpened (gamma) so Solo/Mute behave like
 * BandLab/Moises mixers instead of simple EQ.
 */
export async function separateStems(
  mix: AudioBuffer,
  onProgress?: SeparateProgress,
): Promise<StemBuffers> {
  const sr = mix.sampleRate;
  const nSamples = mix.length;
  const left = mix.getChannelData(0);
  const right = mix.numberOfChannels > 1 ? mix.getChannelData(1) : left;

  const window = hann(NFFT);
  const bins = NFFT / 2;
  const frames = Math.max(1, Math.floor((nSamples - NFFT) / HOP) + 1);
  const hzPerBin = sr / NFFT;
  const binHz = (hz: number) => Math.max(1, Math.min(bins - 1, Math.round(hz / hzPerBin)));
  const bBass = binHz(165);
  const bKick = binHz(95);
  const bSnare = binHz(220);
  const bCymbal = binHz(5500);

  const outL: Record<StemId, Float32Array> = {
    vocals: new Float32Array(nSamples),
    bass: new Float32Array(nSamples),
    drums: new Float32Array(nSamples),
    guitar: new Float32Array(nSamples),
  };
  const outR: Record<StemId, Float32Array> = {
    vocals: new Float32Array(nSamples),
    bass: new Float32Array(nSamples),
    drums: new Float32Array(nSamples),
    guitar: new Float32Array(nSamples),
  };

  const reL = new Float32Array(NFFT);
  const imL = new Float32Array(NFFT);
  const reR = new Float32Array(NFFT);
  const imR = new Float32Array(NFFT);
  const workRe = new Float32Array(NFFT);
  const workIm = new Float32Array(NFFT);

  const magM = new Float32Array(bins);
  const magS = new Float32Array(bins);
  const prevMag = new Float32Array(bins);
  const prevPrevMag = new Float32Array(bins);
  const flux = new Float32Array(bins);
  const smoothFlux = new Float32Array(bins);

  const masks: Record<StemId, Float32Array> = {
    vocals: new Float32Array(bins),
    bass: new Float32Array(bins),
    drums: new Float32Array(bins),
    guitar: new Float32Array(bins),
  };

  onProgress?.(0.02, "Analisando espectro…");

  for (let f = 0; f < frames; f += 1) {
    const start = f * HOP;
    imL.fill(0);
    imR.fill(0);
    for (let i = 0; i < NFFT; i += 1) {
      const idx = start + i;
      const w = window[i];
      reL[i] = (idx < nSamples ? left[idx] : 0) * w;
      reR[i] = (idx < nSamples ? right[idx] : 0) * w;
    }
    fft(reL, imL, false);
    fft(reR, imR, false);

    for (let k = 0; k < bins; k += 1) {
      const mRe = 0.5 * (reL[k] + reR[k]);
      const mIm = 0.5 * (imL[k] + imR[k]);
      const sRe = 0.5 * (reL[k] - reR[k]);
      const sIm = 0.5 * (imL[k] - imR[k]);
      magM[k] = Math.hypot(mRe, mIm);
      magS[k] = Math.hypot(sRe, sIm);
      const mag = magM[k] + magS[k];
      flux[k] = Math.max(0, mag - prevMag[k]);
      smoothFlux[k] = smoothFlux[k] * 0.65 + flux[k] * 0.35;
    }

    for (let k = 1; k < bins - 1; k += 1) {
      const m = magM[k];
      const s = magS[k];
      const tot = m + s + EPS;
      const midRatio = m / tot;
      const sideRatio = s / tot;

      const lMag = Math.hypot(reL[k], imL[k]);
      const rMag = Math.hypot(reR[k], imR[k]);
      const coherence =
        (reL[k] * reR[k] + imL[k] * imR[k]) / (lMag * rMag + EPS);
      const centered = Math.max(0, coherence);

      const hHarm = median3(prevPrevMag[k], prevMag[k], tot - EPS);
      const hPerc = median3(magM[k - 1] + magS[k - 1], tot - EPS, magM[k + 1] + magS[k + 1]);
      const perc = hPerc / (hHarm + hPerc + EPS);
      const harm = 1 - perc;
      const hz = k * hzPerBin;

      const vocalBand = hz > 160 && hz < 5200 ? 1 : hz < 90 || hz > 8000 ? 0.02 : 0.22;
      const bassBand = k <= bBass ? 1 : k < bBass * 1.45 ? 0.28 : 0.02;
      const kickBand = k <= bKick ? 1 : k < bSnare ? 0.35 : 0.08;
      const guitarBand = hz > 200 && hz < 7000 ? 1 : 0.08;
      const air = k >= bCymbal ? 1 : 0.12;
      const onset = flux[k] / (prevMag[k] + 0.06);
      const transient = Math.min(1, onset * 1.8 + smoothFlux[k] * 4);

      // Vocals: harmonic, highly correlated, mid, speech band
      let v =
        harm *
        vocalBand *
        (0.25 + 0.75 * midRatio) *
        (0.2 + 0.8 * centered) *
        (1 - transient * 0.45);

      // Bass: sustained low mid, not a kick spike
      let b = harm * bassBand * midRatio * (1 - Math.min(1, transient * 0.7)) * 1.55;

      // Drums: percussive + onsets + kick/cymbal air
      let d =
        perc * (0.7 * kickBand + 0.9 * transient + 0.55 * air) +
        (1 - harm) * 0.4 * kickBand +
        midRatio * transient * 0.35;

      // Guitar / harmony: wide stereo harmonic residue
      let g =
        harm *
        guitarBand *
        (0.15 + 0.85 * sideRatio) *
        (0.35 + 0.65 * (1 - centered)) *
        (1 - bassBand * 0.8);

      // Keep residual harmonic energy out of vocals when it's wide
      g += harm * sideRatio * guitarBand * 0.35;
      v *= 0.15 + 0.85 * centered * midRatio;

      v = Math.max(v, 1e-6) ** GAMMA;
      b = Math.max(b, 1e-6) ** GAMMA;
      d = Math.max(d, 1e-6) ** GAMMA;
      g = Math.max(g, 1e-6) ** GAMMA;

      const sum = v + b + d + g + EPS;
      masks.vocals[k] = v / sum;
      masks.bass[k] = b / sum;
      masks.drums[k] = d / sum;
      masks.guitar[k] = g / sum;
    }

    for (const id of STEMS) {
      overlayStem(reL, imL, masks[id], window, workRe, workIm, outL[id], start, nSamples);
      overlayStem(reR, imR, masks[id], window, workRe, workIm, outR[id], start, nSamples);
    }

    prevPrevMag.set(prevMag);
    for (let k = 0; k < bins; k += 1) prevMag[k] = magM[k] + magS[k];

    if (f % 24 === 0) {
      onProgress?.(0.05 + (f / frames) * 0.9, "Isolando instrumentos…");
      await yieldThread();
    }
  }

  onProgress?.(0.97, "Montando faixas…");
  const ctx = new OfflineAudioContext(2, nSamples, sr);
  const stems = {} as StemBuffers;
  for (const id of STEMS) {
    const buf = ctx.createBuffer(2, nSamples, sr);
    buf.copyToChannel(outL[id], 0);
    buf.copyToChannel(outR[id], 1);
    stems[id] = buf;
  }
  onProgress?.(1, "Pronto");
  return stems;
}

function overlayStem(
  re: Float32Array,
  im: Float32Array,
  mask: Float32Array,
  window: Float32Array,
  workRe: Float32Array,
  workIm: Float32Array,
  dest: Float32Array,
  start: number,
  nSamples: number,
) {
  const n = re.length;
  const bins = n / 2;
  workRe.set(re);
  workIm.set(im);
  for (let k = 0; k < bins; k += 1) {
    const m = mask[k];
    workRe[k] *= m;
    workIm[k] *= m;
    if (k > 0) {
      const mk = n - k;
      workRe[mk] *= m;
      workIm[mk] *= m;
    }
  }
  fft(workRe, workIm, true);
  for (let i = 0; i < n; i += 1) {
    const idx = start + i;
    if (idx >= nSamples) break;
    dest[idx] += workRe[i] * window[i];
  }
}

export function mixPeaks(buffer: AudioBuffer, buckets = 280): number[] {
  const data = buffer.getChannelData(0);
  const size = Math.max(1, Math.floor(data.length / buckets));
  const peaks: number[] = [];
  for (let i = 0; i < buckets; i += 1) {
    let max = 0;
    const start = i * size;
    const end = Math.min(data.length, start + size);
    for (let j = start; j < end; j += 1) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}
