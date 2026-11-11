import { fadeGain, Music } from './music';
import type { LoadingProgress } from './loading-progress';

const OUTPUT_GAIN = 10 ** (-5 / 20);
const PAUSE_FADE = .5;

/** Interaction tones and synchronized music share one context and mute control. */
export class Sound {
  context: AudioContext | null = null;
  readonly music: Music;
  readonly ready: Promise<void>;
  constructor(loading?: LoadingProgress) { this.music = new Music(loading); this.ready = this.music.ready; }
  private output: GainNode | null = null;
  private pauseGain: GainNode | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private audible = true;
  private paused = true;
  get enabled() { return this.audible; }
  set enabled(value: boolean) {
    this.audible = value;
    if (!this.context || !this.output) return;
    fadeGain(this.output.gain, value ? OUTPUT_GAIN : 0, this.context.currentTime, .005);
  }
  unlock() {
    if (this.context) return;
    this.context = new AudioContext({ sampleRate: 44100 });
    this.output = this.context.createGain(); this.output.gain.value = this.enabled ? OUTPUT_GAIN : 0;
    this.pauseGain = this.context.createGain(); this.pauseGain.gain.value = 0;
    this.output.connect(this.pauseGain).connect(this.context.destination); this.music.start(this.context, this.output);
    void this.context.suspend().catch(() => {});
  }
  setPaused(value: boolean) {
    if (value === this.paused) return;
    this.paused = value;
    clearTimeout(this.pauseTimer);
    const context = this.context;
    if (!context || !this.pauseGain || context.state === 'closed') return;
    const now = context.currentTime, end = now + PAUSE_FADE;
    fadeGain(this.pauseGain.gain, value ? 0 : 1, now, PAUSE_FADE);
    if (!value) { void context.resume().catch(() => {}); return; }
    const suspend = () => {
      if (!this.paused || context.state === 'closed') return;
      const remaining = end - context.currentTime;
      // Wait for the audio clock to reach silence before stopping it.
      if (remaining > 0 && context.state === 'running') this.pauseTimer = setTimeout(suspend, remaining * 1000);
      else void context.suspend().catch(() => {});
    };
    this.pauseTimer = setTimeout(suspend, PAUSE_FADE * 1000);
  }
  play(action: 'take' | 'place' | 'undo') {
    if (!this.enabled || this.paused || !this.context) return;
    const context = this.context, time = context.currentTime;
    const notes = { take: [520, 390], place: [390, 620], undo: [350, 270] }[action];
    notes.forEach((frequency, i) => {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      const start = time + i * 0.065;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.035, start + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      oscillator.connect(gain).connect(this.output!); oscillator.start(start); oscillator.stop(start + 0.24);
    });
  }
  dispose() { clearTimeout(this.pauseTimer); this.music.dispose(); void this.context?.close(); }
}
