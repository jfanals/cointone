export class PingCapture {
  constructor({ onState, onLevel, onPing, onError }) {
    this.callbacks = { onState, onLevel, onPing, onError };
    this.preRoll = [];
    this.active = false;
  }

  async start() {
    if (this.active) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: { ideal: 48000 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await this.context.audioWorklet.addModule('./audio-worklet.js');
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.silence = this.context.createGain();
      this.silence.gain.value = 0;
      this.source.connect(this.node).connect(this.silence).connect(this.context.destination);
      this.node.port.onmessage = event => this.processBlock(event.data);
      this.active = true;
      this.state = 'calibrating';
      this.noiseSamples = [];
      this.calibrationBlocks = Math.ceil(1.2 * this.context.sampleRate / 1024);
      this.callbacks.onState?.('calibrating');
    } catch (error) {
      await this.stop();
      this.callbacks.onError?.(error);
      throw error;
    }
  }

  blockStats(block) {
    let sum = 0, peak = 0;
    for (const value of block) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
    return { rms: Math.sqrt(sum / block.length), peak };
  }

  processBlock(block) {
    if (!this.active) return;
    const { rms, peak } = this.blockStats(block);
    this.callbacks.onLevel?.(Math.min(1, Math.max(rms * 10, peak * .75)));

    if (this.state === 'calibrating') {
      this.noiseSamples.push(rms);
      if (this.noiseSamples.length >= this.calibrationBlocks) {
        const sorted = [...this.noiseSamples].sort((a, b) => a - b);
        this.noiseFloor = sorted[Math.floor(sorted.length * .65)] || .001;
        // Keep onset detection conservative, but do not use this high threshold to
        // decide when the much quieter resonance tail has ended.
        this.trigger = Math.max(.006, this.noiseFloor * 5);
        this.state = 'listening';
        this.callbacks.onState?.('listening');
      }
      return;
    }

    if (this.state === 'cooldown') {
      if (rms < this.trigger * .7) this.quietBlocks++;
      else this.quietBlocks = 0;
      if (this.quietBlocks > 12) { this.state = 'listening'; this.callbacks.onState?.('listening'); }
      return;
    }

    if (this.state === 'listening') {
      this.preRoll.push(block.slice());
      while (this.preRoll.length > 4) this.preRoll.shift();
      if (peak > this.trigger * 1.35 || rms > this.trigger) {
        this.state = 'recording';
        this.eventBlocks = [...this.preRoll];
        this.preRoll = [];
        this.eventQuietBlocks = 0;
        this.callbacks.onState?.('recording');
      }
      return;
    }

    if (this.state === 'recording') {
      this.eventBlocks.push(block.slice());
      const elapsed = this.eventBlocks.length * block.length / this.context.sampleRate;
      // A coin's sustained ring is normally far quieter than its initial impact.
      // Comparing the tail with the onset trigger truncated valid recordings.
      const tailThreshold = Math.max(this.noiseFloor * 1.8, .0006);
      if (rms < tailThreshold) this.eventQuietBlocks++;
      else this.eventQuietBlocks = 0;
      const quietSeconds = this.eventQuietBlocks * block.length / this.context.sampleRate;
      if ((elapsed > .5 && quietSeconds > .42) || elapsed >= 3.2) this.finishEvent();
    }
  }

  finishEvent() {
    const length = this.eventBlocks.reduce((sum, block) => sum + block.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    this.eventBlocks.forEach(block => { samples.set(block, offset); offset += block.length; });
    this.state = 'cooldown';
    this.quietBlocks = 0;
    const track = this.stream?.getAudioTracks()[0];
    this.callbacks.onPing?.({
      samples,
      sampleRate: this.context.sampleRate,
      metadata: { device: track?.label || 'Default microphone', settings: track?.getSettings?.() || {}, noiseFloor: this.noiseFloor, trigger: this.trigger }
    });
  }

  async stop() {
    this.active = false;
    this.node?.disconnect();
    this.source?.disconnect();
    this.silence?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = this.stream = this.node = this.source = null;
    this.callbacks.onState?.('idle');
    this.callbacks.onLevel?.(0);
  }
}
