export interface TutorialObservation {
  active: boolean;
  speed: number;
  steer: number;
  boost: number;
  aiming: boolean;
}

/** Six lessons advance only from observations/actions made in the current lesson. */
export class TutorialProgress {
  step = 0;
  private progress = 0;
  private action = false;

  get complete() { return this.step === 6; }
  reset() { this.step = 0; this.progress = 0; this.action = false; }
  record(action: 'throw' | 'recover') {
    if ((action === 'throw' && this.step === 4) || (action === 'recover' && this.step === 5)) this.action = true;
  }
  update(dt: number, observation: TutorialObservation): boolean {
    if (!observation.active || this.complete || !Number.isFinite(dt) || dt <= 0) return false;
    const done = [
      Math.abs(observation.speed) > 4,
      Math.abs(observation.steer) > .4 && Math.abs(observation.speed) > 2,
      observation.boost > 0,
      observation.aiming,
      this.action,
      this.action,
    ][this.step];
    // Driving and holding aim must be sustained, not accumulated from stray taps.
    this.progress = done ? this.progress + dt : 0;
    if (this.progress <= (this.step < 2 ? .3 : .1)) return false;
    this.step++; this.progress = 0; this.action = false;
    return true;
  }
}
