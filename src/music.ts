import { PASSAGE_GOALS, type RoomId } from './world';

const files = import.meta.glob<string>('../music/SAMEWHERE-*.mp3', { eager: true, query: '?url', import: 'default' });
const urls = Array.from({ length: 6 }, (_, i) => files[`../music/SAMEWHERE-${String(i + 1).padStart(3, '0')}.mp3`]);
const LOOP_FADE = .005, LAYER_FADE = 15, ENDING_FADE = 12;
const BASE_GAIN = 10 ** (-10 / 20);

export function fadeGain(gain: AudioParam, target: number, time: number, duration: number) {
  const value = gain.value;
  gain.cancelAndHoldAtTime(time);
  // An explicit starting point prevents a first ramp from starting at context time zero.
  gain.setValueAtTime(value, time);
  gain.linearRampToValueAtTime(target, time + duration);
}

/** One sample clock and loop length for all stems, including inaudible ones. */
export class Music {
  readonly ready: Promise<void>;
  readonly active = new Set([0]);
  readonly layers: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private buffers: AudioBuffer[] = [];
  private context: AudioContext | null = null;
  private ending = false;
  private readonly download = new AbortController();
  constructor() { this.ready = this.load(); }
  private async load() {
    const decoder = new OfflineAudioContext(2, 1, 44100);
    this.buffers = await Promise.all(urls.map(async url => {
      if (!url) throw new Error('Missing music stem');
      const response = await fetch(url, { signal: this.download.signal });
      if (!response.ok) throw new Error(`Music download failed: ${response.status}`);
      const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
      const fade = Math.min(Math.round(buffer.sampleRate * LOOP_FADE), Math.floor(buffer.length / 2));
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = 0; i < fade; i++) {
          const gain = i / fade;
          samples[i] *= gain; samples[samples.length - 1 - i] *= gain;
        }
      }
      return buffer;
    }));
    if (this.buffers.some(buffer => buffer.length !== this.buffers[0].length)) throw new Error('Music stems must have matching lengths');
  }
  start(context: AudioContext, output: AudioNode) {
    if (this.layers.length) return;
    this.context = context;
    const when = context.currentTime + .03, duration = this.buffers[0].duration;
    for (const [index, buffer] of this.buffers.entries()) {
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffer; source.loop = true; source.loopEnd = duration;
      gain.gain.value = index === 0 ? BASE_GAIN : this.active.has(index) ? 1 : 0;
      source.connect(gain).connect(output); source.start(when);
      this.layers.push({ source, gain });
    }
  }
  update(room: RoomId, passageProgress: number) {
    if (this.ending) return;
    if (room === 'B') this.activate(1);
    if (room === 'D') this.activate(2);
    if (room === 'G') this.activate(3);
    if (room === 'A' && passageProgress >= PASSAGE_GOALS.length) this.activate(4);
    if (passageProgress > PASSAGE_GOALS.length) this.activate(5);
  }
  private activate(index: number) {
    if (this.active.has(index)) return;
    this.active.add(index);
    if (this.context && this.layers[index]) {
      fadeGain(this.layers[index].gain.gain, 1, this.context.currentTime, LAYER_FADE);
    }
  }
  finish() {
    if (this.ending) return;
    this.ending = true;
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const [index, { gain }] of this.layers.entries()) if (index !== 4) fadeGain(gain.gain, 0, now, ENDING_FADE);
  }
  reset() {
    this.ending = false;
    this.active.clear(); this.active.add(0);
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const [index, { gain }] of this.layers.entries()) {
      fadeGain(gain.gain, index === 0 ? BASE_GAIN : 0, now, LOOP_FADE);
    }
  }
  dispose() {
    this.download.abort();
    for (const { source, gain } of this.layers) { source.stop(); source.disconnect(); gain.disconnect(); }
    this.layers.length = 0; this.buffers = [];
  }
}
