import type { DriveInput } from './race';

/** Keyboard/gamepad share one input snapshot. Blur clears held actions. */
export class Input {
  private keys = new Set<string>();
  private wasAim = false;
  private padPause = false;
  private padSwitch = false;
  private padRecover = false;
  private padIndex: number | null = null;
  private padAiming = false;
  private cancelPadAim = false;
  private clearRevision = 0;
  private pointer = 0;
  device = 'キーボード';
  muted = false;
  aiming = false;
  aimOffset = 0;
  onPause = () => {};
  onDeactivate = () => {};
  onThrow = () => {};
  onSwitch = () => {};
  onRecover = () => {};
  constructor() {
    window.addEventListener('keydown', e => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat && e.code === 'Escape') this.onPause();
      if (!e.repeat && e.code === 'KeyE') this.onSwitch();
      if (!e.repeat && e.code === 'KeyR') this.onRecover();
      this.keys.add(e.code); this.device = 'キーボード';
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.clear(); this.onDeactivate(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.clear(); this.onDeactivate(); } });
    window.addEventListener('gamepaddisconnected', () => {
      this.clear(); this.resetPad(); this.device = 'キーボード'; this.onDeactivate();
    });
    window.addEventListener('pointermove', e => { this.pointer = e.clientX / window.innerWidth * 2 - 1; });
  }
  clear() {
    this.clearRevision++;
    this.keys.clear(); this.wasAim = false; this.aiming = false;
    // Pause/focus loss cancels a prepared throw. A still-held RB must first be
    // released before it can prepare another projectile after resuming.
    this.cancelPadAim = true;
  }
  private resetPad() {
    this.padPause = false; this.padSwitch = false; this.padRecover = false;
    this.padIndex = null; this.padAiming = false;
  }
  sample(): DriveInput {
    const clearRevision = this.clearRevision;
    const held = (...codes: string[]) => codes.some(c => this.keys.has(c));
    let throttle = held('KeyW','ArrowUp') ? 1 : 0;
    let brake = held('KeyS','ArrowDown') ? 1 : 0;
    let steer = (held('KeyA','ArrowLeft') ? 1 : 0) - (held('KeyD','ArrowRight') ? 1 : 0);
    let drift = held('ShiftLeft','ShiftRight');
    let aim = held('Space');
    this.aimOffset = this.pointer * -0.65;
    const pad = [...(navigator.getGamepads?.() ?? [])].find(p => p?.connected && p.mapping === 'standard');
    if ((pad?.index ?? null) !== this.padIndex) {
      // Loss/replacement can be observed before the disconnect event. It is
      // cancellation, never a release gesture that should throw an item.
      if (this.padAiming) this.wasAim = false;
      this.resetPad(); this.padIndex = pad?.index ?? null;
    }
    if (pad) {
      const dead = (v: number) => Math.abs(v) < .13 ? 0 : v;
      const active = pad.buttons.some(b => b.pressed) || pad.axes.some(a => Math.abs(a) > .15);
      if (active) this.device = 'ゲームパッド';
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      if (Math.abs(pad.axes[0] ?? 0) > .13) steer = -dead(pad.axes[0]);
      drift ||= pad.buttons[0]?.pressed ?? false;
      const padAim = pad.buttons[5]?.pressed ?? false;
      if (!padAim) this.cancelPadAim = false;
      this.padAiming = padAim && !this.cancelPadAim;
      aim ||= this.padAiming;
      if (this.device === 'ゲームパッド') this.aimOffset = -dead(pad.axes[2] ?? 0) * .65;
      const pause = pad.buttons[9]?.pressed ?? false;
      const change = pad.buttons[2]?.pressed ?? false;
      const recover = pad.buttons[3]?.pressed ?? false;
      if (pause && !this.padPause) this.onPause();
      if (change && !this.padSwitch) this.onSwitch();
      if (recover && !this.padRecover) this.onRecover();
      this.padPause = pause; this.padSwitch = change; this.padRecover = recover;
    }
    // A Start callback can pause/resume (and clear) during this sample. Do not
    // restore the prepared throw from the snapshot taken before that callback.
    if (this.clearRevision !== clearRevision) aim = false;
    this.aiming = aim;
    if (!this.muted && this.wasAim && !aim) this.onThrow();
    this.wasAim = aim;
    return { throttle, brake, steer, drift, recover: false };
  }
}
