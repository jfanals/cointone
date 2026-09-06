const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const MIN_RESONANCE_HZ = 2000;

function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const wLenR = Math.cos(angle), wLenI = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const even = start + j, odd = even + length / 2;
        const tr = real[odd] * wr - imag[odd] * wi;
        const ti = real[odd] * wi + imag[odd] * wr;
        real[odd] = real[even] - tr; imag[odd] = imag[even] - ti;
        real[even] += tr; imag[even] += ti;
        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR; wr = nextWr;
      }
    }
  }
}

function rms(values, start = 0, end = values.length) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function estimateDecay(points) {
  if (points.length < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  points.forEach(([x, amplitude]) => {
    const y = Math.log(Math.max(amplitude, 1e-12));
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  });
  const slope = (points.length * sxy - sx * sy) / (points.length * sxx - sx * sx || 1);
  return slope < -.05 ? clamp(-1 / slope, .03, 8) : null;
}

export function analyzePing(samples, sampleRate) {
  let peak = 0, peakIndex = 0, clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > peak) { peak = value; peakIndex = i; }
    if (value >= .985) clipped++;
  }
  const noiseEnd = Math.max(1, peakIndex - Math.round(sampleRate * .018));
  const noiseStart = Math.max(0, noiseEnd - Math.round(sampleRate * .045));
  const noiseRms = rms(samples, noiseStart, noiseEnd);
  const signalRms = rms(samples, peakIndex, Math.min(samples.length, peakIndex + Math.round(sampleRate * .15)));
  const snrDb = 20 * Math.log10((signalRms + 1e-9) / (noiseRms + 1e-9));

  const fftSize = sampleRate >= 40000 ? 4096 : 2048;
  const hop = fftSize / 4;
  const frameClusters = [];
  let frameNumber = 0;
  for (let offset = Math.max(0, peakIndex - 128); offset + fftSize <= samples.length; offset += hop) {
    const real = new Float64Array(fftSize), imag = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) real[i] = samples[offset + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
    fft(real, imag);
    const mags = new Float64Array(fftSize / 2);
    let maxMag = 0;
    for (let i = 1; i < mags.length; i++) {
      mags[i] = Math.hypot(real[i], imag[i]);
      if (mags[i] > maxMag) maxMag = mags[i];
    }
    const peaks = [];
    const minBin = Math.ceil(MIN_RESONANCE_HZ * fftSize / sampleRate);
    const maxBin = Math.min(mags.length - 2, Math.floor(20000 * fftSize / sampleRate));
    for (let i = minBin; i <= maxBin; i++) {
      if (mags[i] > maxMag * .035 && mags[i] > mags[i - 1] && mags[i] >= mags[i + 1]) {
        const denominator = mags[i - 1] - 2 * mags[i] + mags[i + 1];
        const delta = denominator ? .5 * (mags[i - 1] - mags[i + 1]) / denominator : 0;
        peaks.push({ frequency: (i + clamp(delta, -.5, .5)) * sampleRate / fftSize, magnitude: mags[i] });
      }
    }
    peaks.sort((a, b) => b.magnitude - a.magnitude);
    peaks.slice(0, 12).forEach(candidate => {
      const tolerance = Math.max(32, candidate.frequency * .006);
      let cluster = frameClusters.find(c => Math.abs(c.frequency - candidate.frequency) <= tolerance);
      if (!cluster) {
        cluster = { frequency: candidate.frequency, weight: 0, frames: new Set(), points: [] };
        frameClusters.push(cluster);
      }
      cluster.frequency = (cluster.frequency * cluster.weight + candidate.frequency * candidate.magnitude) / (cluster.weight + candidate.magnitude);
      cluster.weight += candidate.magnitude;
      cluster.frames.add(frameNumber);
      cluster.points.push([(offset - peakIndex) / sampleRate, candidate.magnitude]);
    });
    frameNumber++;
  }

  const strongest = Math.max(1e-12, ...frameClusters.map(c => c.weight));
  const resonances = frameClusters
    .filter(c => c.frames.size >= Math.max(2, Math.ceil(frameNumber * .12)))
    .map(c => ({
      frequency: Math.round(c.frequency * 10) / 10,
      strength: c.weight / strongest,
      support: c.frames.size / Math.max(1, frameNumber),
      decay: estimateDecay(c.points)
    }))
    .sort((a, b) => b.strength * b.support - a.strength * a.support)
    .slice(0, 7)
    .sort((a, b) => a.frequency - b.frequency);

  const envelopeWindow = Math.max(64, Math.round(sampleRate * .02));
  // The impact sample can be tens or hundreds of times louder than the actual
  // ring, so a threshold based on `peak` incorrectly labels clean pings short.
  // Estimate the ring level from windowed RMS after the first few milliseconds.
  let ringReference = 0;
  const referenceStart = peakIndex + Math.round(sampleRate * .008);
  const referenceEnd = Math.min(samples.length, peakIndex + Math.round(sampleRate * .22));
  for (let i = referenceStart; i + envelopeWindow <= referenceEnd; i += envelopeWindow) {
    ringReference = Math.max(ringReference, rms(samples, i, i + envelopeWindow));
  }
  const endThreshold = Math.max(noiseRms * 2.0, ringReference * .025, .00012);
  let ringEnd = peakIndex;
  for (let i = peakIndex; i + envelopeWindow < samples.length; i += envelopeWindow) {
    if (rms(samples, i, i + envelopeWindow) > endThreshold) ringEnd = i + envelopeWindow;
  }
  const ringDuration = Math.max(0, (ringEnd - peakIndex) / sampleRate);
  const clippingPercent = clipped / Math.max(1, samples.length) * 100;
  const reasons = [];
  if (peak < .015) reasons.push('too quiet');
  if (clippingPercent > .2) reasons.push('clipped');
  if (snrDb < 10) reasons.push('background noise too high');
  if (ringDuration < .10) reasons.push('ring too short');
  if (resonances.length < 2) reasons.push('not enough stable resonances');
  const qualityScore = Math.round(clamp((snrDb - 5) * 3 + ringDuration * 22 + resonances.length * 7 - clippingPercent * 10, 0, 100));

  return {
    resonances,
    quality: { accepted: reasons.length === 0, score: qualityScore, reasons, peak, noiseRms, signalRms, snrDb, ringDuration, clippingPercent, endThreshold }
  };
}

const PROFILE_MIN_SUPPORT = .8;
const PROFILE_CLUSTER_RATIO = .012;
const MATCH_TOLERANCE_RATIO = .02;

export function buildProfile(recordings, includedFrequencies = []) {
  const clusters = [];
  recordings.forEach(recording => {
    recording.features?.resonances?.filter(resonance => resonance.frequency >= MIN_RESONANCE_HZ).forEach(resonance => {
      // Group the same mode across captures while keeping nearby, genuinely
      // separate resonances distinct.
      const tolerance = Math.max(45, resonance.frequency * PROFILE_CLUSTER_RATIO);
      let cluster = clusters.find(c => Math.abs(c.mean - resonance.frequency) <= tolerance && !c.recordingIds.has(recording.id));
      if (!cluster) {
        cluster = { values: [], decays: [], recordingIds: new Set(), mean: resonance.frequency, strength: 0 };
        clusters.push(cluster);
      }
      cluster.values.push(resonance.frequency);
      if (resonance.decay) cluster.decays.push(resonance.decay);
      cluster.recordingIds.add(recording.id);
      cluster.strength += resonance.strength || 0;
      cluster.mean = cluster.values.reduce((a, b) => a + b, 0) / cluster.values.length;
    });
  });
  // Keep every observed cluster available for inspection. Repeatable clusters
  // are selected automatically; users may explicitly include an occasional
  // mode when they know it belongs to the coin.
  const minimumSupport = Math.max(2, Math.ceil(recordings.length * PROFILE_MIN_SUPPORT));
  const candidates = clusters.map(c => {
    const mean = c.mean;
    const variance = c.values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, c.values.length - 1);
    const automatic = c.recordingIds.size >= minimumSupport;
    const manuallyIncluded = includedFrequencies.some(frequency =>
      Math.abs(frequency - mean) <= Math.max(45, mean * PROFILE_CLUSTER_RATIO)
    );
    return {
      frequency: mean,
      deviation: Math.sqrt(variance),
      support: c.recordingIds.size / Math.max(1, recordings.length),
      occurrences: c.recordingIds.size,
      strength: c.strength / c.values.length,
      decay: c.decays.length ? c.decays.reduce((a, b) => a + b, 0) / c.decays.length : null,
      automatic,
      manuallyIncluded,
      selected: automatic || manuallyIncluded
    };
  }).sort((a, b) => a.frequency - b.frequency);
  const resonances = candidates.filter(candidate => candidate.selected);
  const consistency = recordings.length < 3 ? 'Learning' : resonances.length >= 2 && resonances.every(r => r.support >= .7) ? 'High' : resonances.length >= 2 ? 'Moderate' : 'Low';
  return { sampleCount: recordings.length, resonances, candidates, consistency };
}

export function matchProfile(features, profile) {
  const targets = profile?.resonances?.filter(resonance => resonance.frequency >= MIN_RESONANCE_HZ) || [];
  const observedResonances = features?.resonances?.filter(resonance => resonance.frequency >= MIN_RESONANCE_HZ) || [];
  if (!targets.length || !observedResonances.length) return { score: 0, matched: 0 };

  // Find the best one-to-one assignments. A single observed peak must not be
  // allowed to satisfy two nearby profile resonances.
  const pairs = [];
  targets.forEach((target, targetIndex) => {
    const toleranceRatio = target.tolerance || MATCH_TOLERANCE_RATIO;
    const tolerance = Math.max(55, target.frequency * toleranceRatio, (target.deviation || 0) * 3);
    observedResonances.forEach((observed, observedIndex) => pairs.push({
      targetIndex,
      observedIndex,
      distance: Math.abs(observed.frequency - target.frequency) / tolerance
    }));
  });
  pairs.sort((a, b) => a.distance - b.distance);
  const assignments = new Map();
  const usedObserved = new Set();
  pairs.forEach(pair => {
    if (!assignments.has(pair.targetIndex) && !usedObserved.has(pair.observedIndex)) {
      assignments.set(pair.targetIndex, pair);
      usedObserved.add(pair.observedIndex);
    }
  });

  let weighted = 0, totalWeight = 0, matched = 0;
  targets.forEach((target, targetIndex) => {
    const weight = .5 + target.support;
    const assignment = assignments.get(targetIndex);
    let similarity = 0;
    if (assignment) {
      // The displayed score describes resonance-frequency similarity. Decay is
      // useful diagnostic evidence, but it varies substantially with how the
      // coin is held and struck. Including it here made identical frequencies
      // score only 85–99%, which was both surprising and misleading.
      similarity = Math.exp(-.5 * assignment.distance * assignment.distance);
      if (assignment.distance <= 1) matched++;
    }
    weighted += similarity * weight;
    totalWeight += weight;
  });
  const coverage = matched / targets.length;
  const score = 100 * (weighted / totalWeight) * (.65 + .35 * coverage) * (matched >= 2 ? 1 : .55);
  return { score: Math.round(clamp(score, 0, 100)), matched };
}

export function averageFeatureSets(featureSets) {
  if (featureSets.length === 1) return featureSets[0];
  const synthetic = featureSets.map((features, index) => ({ id: String(index), features }));
  return { resonances: buildProfile(synthetic).resonances.map(r => ({ frequency: r.frequency, strength: r.strength, support: r.support, decay: r.decay })) };
}

export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, clamp(samples[i], -1, 1) * (samples[i] < 0 ? 32768 : 32767), true);
  return new Blob([buffer], { type: 'audio/wav' });
}
