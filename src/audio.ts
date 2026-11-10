import { fadeGain, Music } from './music';

const OUTPUT_GAIN = 10 ** (-5 / 20);

/** Interaction tones and synchronized music share one context and mute control. */
export class Sound {
  context: AudioContext | null = null;
  readonly music = new Music();
  readonly ready = this.music.ready;
  private output: GainNode | null = null;
  private audible = true;
  get enabled() { return this.audible; }
  set enabled(value: boolean) {
    this.audible = value;
    if (!this.context || !this.output) return;
    fadeGain(this.output.gain, value ? OUTPUT_GAIN : 0, this.context.currentTime, .005);
  }
  unlock() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 44100 });
      this.output = this.context.createGain(); this.output.gain.value = this.enabled ? OUTPUT_GAIN : 0;
      this.output.connect(this.context.destination); this.music.start(this.context, this.output);
    }
    void this.context.resume();
  }
  play(action: 'take' | 'place' | 'undo') {
    if (!this.enabled || !this.context) return;
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
  dispose() { this.music.dispose(); void this.context?.close(); }
}
