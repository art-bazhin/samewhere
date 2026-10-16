/** Small, synthesized interaction tones. Audio is created only after a user gesture. */
export class Sound {
  context: AudioContext | null = null;
  enabled = true;
  unlock() { this.context ??= new AudioContext(); void this.context.resume(); }
  play(action: 'take' | 'place' | 'undo') {
    if (!this.enabled || !this.context) return;
    const context = this.context, time = context.currentTime;
    const notes = { take: [520, 390], place: [390, 620], undo: [350, 270] }[action];
    notes.forEach((frequency, i) => {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      const start = time + i * 0.065;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.035, start + 0.012); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      oscillator.connect(gain).connect(context.destination); oscillator.start(start); oscillator.stop(start + 0.24);
    });
  }
}
