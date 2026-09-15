import { fft, hann } from "./fft";
import type { StemId } from "./stem-engine";

export type StemBuffers = Record<StemId, AudioBuffer>;

export type SeparateProgress = (ratio: number, label: string) => void;

const NFFT = 2048;
const HOP = 512;
const EPS = 1e-8;
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
 * Spectral source separation in the browser:
 *  - mid/side (center vs wide)
 *  - light HPSS (harmonic vs percussive)
 *  - frequency priors + L/R correlation
 * Soft masks sum to 1 so soloing a stem does not leave holes.
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
  const bBass = binHz(180);
  const bKick = binHz(90);
  const bCymbal = binHz(5000);

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
      const w = window[i] as number;
      reL[i] = (idx < nSamples ? (left[idx] as number) : 0) * w;
      reR[i] = (idx < nSamples ? (right[idx] as number) : 0) * w;
    }
    fft(reL, imL, false);
    fft(reR, imR, false);

    for (let k = 0; k < bins; k += 1) {
      const mRe = 0.5 * ((reL[k] as number) + (reR[k] as number));
      const mIm = 0.5 * ((imL[k] as number) + (imR[k] as number));
      const sRe = 0.5 * ((reL[k] as number) - (reR[k] as number));
      const sIm = 0.5 * ((imL[k] as number) - (imR[k] as number));
      magM[k] = Math.hypot(mRe, mIm);
      magS[k] = Math.hypot(sRe, sIm);
      const mag = (magM[k] as number) + (magS[k] as number);
      flux[k] = Math.max(0, mag - (prevMag[k] as number));
    }

    for (let k = 1; k < bins - 1; k += 1) {
      const m = magM[k] as number;
      const s = magS[k] as number;
      const tot = m + s + EPS;
      const midRatio = m / tot;
      const sideRatio = s / tot;
      const hHarm = median3(prevPrevMag[k] as number, prevMag[k] as number, tot - EPS);
      const hPerc = median3(
        (magM[k - 1] as number) + (magS[k - 1] as number),
        tot - EPS,
        (magM[k + 1] as number) + (magS[k + 1] as number),
      );
      const perc = hPerc / (hHarm + hPerc + EPS);
      const harm = 1 - perc;
      const hz = k * hzPerBin;
      const vocalBand = hz > 180 && hz < 4800 ? 1 : hz < 120 || hz > 7000 ? 0.05 : 0.35;
      const bassBand = k <= bBass ? 1 : k < bBass * 1.6 ? 0.35 : 0.04;
      const kickBand = k <= bKick ? 1 : 0.15;
      const guitarBand = hz > 220 && hz < 6500 ? 1 : 0.12;
      const air = k >= bCymbal ? 1 : 0.2;
      const onset = (flux[k] as number) / ((prevMag[k] as number) + 0.08);

      let v = harm * midRatio * vocalBand * (0.55 + 0.45 * midRatio);
      let b = harm * midRatio * bassBand * 1.35;
      let d = perc * (0.55 * kickBand + 0.7 * onset + 0.45 * air);
      let g = harm * sideRatio * guitarBand * 1.25;
      d += (1 - harm) * 0.35 * kickBand + midRatio * onset * 0.25;
      g *= 0.35 + 0.65 * sideRatio;
      v *= 0.4 + 0.6 * midRatio;

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
    for (let k = 0; k < bins; k += 1)
      prevMag[k] = (magM[k] as number) + (magS[k] as number);

    if (f % 24 === 0) {
      onProgress?.(0.05 + (f / frames) * 0.9, "Separando faixas…");
      await yieldThread();
    }
  }

  onProgress?.(0.97, "Montando buffers…");
  const ctx = new OfflineAudioContext(2, nSamples, sr);
  const stems = {} as StemBuffers;
  for (const id of STEMS) {
    const buf = ctx.createBuffer(2, nSamples, sr);
    buf.copyToChannel(new Float32Array(outL[id]), 0);
    buf.copyToChannel(new Float32Array(outR[id]), 1);
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
    const m = mask[k] as number;
    workRe[k] = (workRe[k] as number) * m;
    workIm[k] = (workIm[k] as number) * m;
    if (k > 0) {
      const mk = n - k;
      workRe[mk] = (workRe[mk] as number) * m;
      workIm[mk] = (workIm[mk] as number) * m;
    }
  }
  fft(workRe, workIm, true);
  for (let i = 0; i < n; i += 1) {
    const idx = start + i;
    if (idx >= nSamples) break;
    dest[idx] = (dest[idx] as number) + (workRe[i] as number) * (window[i] as number);
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
      const v = Math.abs(data[j] as number);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}
