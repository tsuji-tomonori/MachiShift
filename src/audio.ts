/** Original synthesized cues; no recordings or third-party game assets. */
export class Sound {
  private context?: AudioContext;
  enabled = true;
  unlock() { this.context ??= new AudioContext(); void this.context.resume(); }
  cue(kind: 'tick' | 'go' | 'pickup' | 'paint' | 'blast' | 'boost' | 'finish') {
    if (!this.enabled || !this.context) return;
    const ctx = this.context, now = ctx.currentTime;
    const oscillator = ctx.createOscillator(), gain = ctx.createGain();
    const frequency = {tick:440,go:880,pickup:660,paint:520,blast:100,boost:260,finish:880}[kind];
    const duration = kind === 'blast' ? .5 : .2;
    oscillator.type = kind === 'blast' ? 'sawtooth' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'blast' ? 22 : frequency * 1.7, now + duration);
    gain.gain.setValueAtTime(kind === 'blast' ? .07 : .12, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    oscillator.connect(gain); gain.connect(ctx.destination);
    oscillator.start(); oscillator.stop(now + duration);
  }
}
