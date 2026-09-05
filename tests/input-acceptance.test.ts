import { afterEach, expect, it, vi } from 'vitest';
import { Input } from '../src/input';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const win = Object.assign(new EventTarget(), { innerWidth: 1000 });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  let pads: Array<Gamepad | null> = [];
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { getGamepads: () => pads });
  const input = new Input();
  const callbacks = { pause: vi.fn(), deactivate: vi.fn(), throw: vi.fn(), switch: vi.fn(), recover: vi.fn() };
  input.onPause = callbacks.pause; input.onDeactivate = callbacks.deactivate;
  input.onThrow = callbacks.throw; input.onSwitch = callbacks.switch; input.onRecover = callbacks.recover;
  function key(code: string, down = true, repeat = false) {
    const event = Object.assign(new Event(down ? 'keydown' : 'keyup', { cancelable: true }), { code, repeat });
    win.dispatchEvent(event); return event;
  }
  return { input, win, doc, callbacks, key, pads: (value: Array<Gamepad | null>) => { pads = value; } };
}

function pad(index = 0, mapping: GamepadMappingType = 'standard') {
  return {
    id: 'test-double-not-physical-controller', index, mapping, connected: true, timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  } as unknown as Gamepad;
}
function button(gamepad: Gamepad, index: number, value: number) {
  Object.assign(gamepad.buttons[index], { pressed: value > .5, value });
}

it('GAME-05 keyboard mappings deliver acceleration braking steering drift and one-shot actions', () => {
  const { input, key, callbacks } = setup();
  key('KeyW'); key('KeyS'); key('KeyA'); key('ShiftLeft');
  expect(input.sample()).toEqual({ throttle: 1, brake: 1, steer: 1, drift: true, recover: false });
  key('KeyD'); expect(input.sample().steer).toBe(0);
  for (const code of ['Escape', 'KeyE', 'KeyR']) { key(code); key(code, true, true); key(code, false); }
  expect(callbacks.pause).toHaveBeenCalledTimes(1);
  expect(callbacks.switch).toHaveBeenCalledTimes(1);
  expect(callbacks.recover).toHaveBeenCalledTimes(1);
  input.clear(); key('ArrowUp'); key('ArrowDown'); key('ArrowRight'); key('ShiftRight');
  expect(input.sample()).toEqual({ throttle: 1, brake: 1, steer: -1, drift: true, recover: false });
  expect(key('Space').defaultPrevented).toBe(true);
});

it('GAME-05 keyboard aim releases exactly one projectile and pointer changes aim', () => {
  const { input, key, win, callbacks } = setup();
  win.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 1000 }));
  key('Space'); input.sample(); expect(input.aiming).toBe(true); expect(input.aimOffset).toBe(-.65);
  input.sample(); expect(callbacks.throw).not.toHaveBeenCalled();
  key('Space', false); input.sample(); input.sample();
  expect(callbacks.throw).toHaveBeenCalledTimes(1);
});

it('GAME-05 standard gamepad maps analog triggers sticks drift aim and edge-triggered buttons', () => {
  const { input, pads, callbacks } = setup(); const controller = pad(); pads([null, controller]);
  button(controller, 7, .8); button(controller, 6, .3); button(controller, 0, 1); button(controller, 5, 1);
  Object.assign(controller.axes, { 0: -.75, 2: .5 });
  for (const index of [9, 2, 3]) button(controller, index, 1);
  expect(input.sample()).toEqual({ throttle: .8, brake: .3, steer: .75, drift: true, recover: false });
  expect(input.device).toBe('ゲームパッド'); expect(input.aiming).toBe(true); expect(input.aimOffset).toBe(-.325);
  input.sample();
  expect(callbacks.pause).toHaveBeenCalledTimes(1); expect(callbacks.switch).toHaveBeenCalledTimes(1); expect(callbacks.recover).toHaveBeenCalledTimes(1);
  button(controller, 5, 0); input.sample(); input.sample(); expect(callbacks.throw).toHaveBeenCalledTimes(1);
  for (const index of [9, 2, 3]) button(controller, index, 0);
  input.sample(); for (const index of [9, 2, 3]) button(controller, index, 1);
  input.sample(); expect(callbacks.pause).toHaveBeenCalledTimes(2); expect(callbacks.switch).toHaveBeenCalledTimes(2); expect(callbacks.recover).toHaveBeenCalledTimes(2);
});

it('GAME-05 pad dead zone and nonstandard mapping cannot override keyboard controls', () => {
  const { input, pads, key } = setup(); const controller = pad();
  Object.assign(controller.axes, { 0: .12, 2: -.12 }); pads([controller]); key('KeyA');
  expect(input.sample().steer).toBe(1); expect(input.device).toBe('キーボード');
  const unsupported = pad(1, ''); button(unsupported, 7, 1); pads([unsupported]);
  expect(input.sample().throttle).toBe(0);
});

it('GAME-05 keyboard remains usable when the browser does not expose the gamepad API', () => {
  const { input, key } = setup(); vi.stubGlobal('navigator', {}); key('KeyW');
  expect(input.sample().throttle).toBe(1);
});

it('GAME-05 gamepad disconnect cancels aim and reconnect restores Start X Y edges', () => {
  const { input, pads, win, callbacks } = setup(); const controller = pad();
  for (const index of [5, 9, 2, 3]) button(controller, index, 1);
  pads([controller]); input.sample(); pads([]); win.dispatchEvent(new Event('gamepaddisconnected')); input.sample();
  expect(input.aiming).toBe(false); expect(input.device).toBe('キーボード'); expect(callbacks.throw).not.toHaveBeenCalled();
  expect(callbacks.deactivate).toHaveBeenCalledTimes(1);
  button(controller, 5, 0); pads([controller]); input.sample();
  expect(callbacks.pause).toHaveBeenCalledTimes(2); expect(callbacks.switch).toHaveBeenCalledTimes(2); expect(callbacks.recover).toHaveBeenCalledTimes(2);
});

it('GAME-05 disappearance before the disconnect event never synthesizes a throw', () => {
  const { input, pads, callbacks } = setup(); const controller = pad();
  button(controller, 5, 1); pads([controller]); input.sample();
  pads([]); input.sample(); expect(input.aiming).toBe(false); expect(callbacks.throw).not.toHaveBeenCalled();
});

it('GAME-05 pause and repeated focus loss require a fresh RB gesture after resuming', () => {
  const { input, pads, win, doc, callbacks } = setup(); const controller = pad(); pads([controller]);
  button(controller, 5, 1); input.sample();
  win.dispatchEvent(new Event('blur')); doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  input.sample(); expect(input.aiming).toBe(false);
  button(controller, 5, 0); input.sample(); expect(callbacks.throw).not.toHaveBeenCalled();
  expect(callbacks.pause).not.toHaveBeenCalled();
  button(controller, 5, 1); input.sample(); expect(input.aiming).toBe(true);
  button(controller, 5, 0); input.sample(); expect(callbacks.throw).toHaveBeenCalledTimes(1);
});

it('GAME-05 pause clear does not re-trigger a held gamepad Start and resume automatically', () => {
  const { input, pads, callbacks } = setup(); const controller = pad(); pads([controller]);
  input.onPause = () => { callbacks.pause(); input.clear(); };
  button(controller, 9, 1); input.sample(); input.sample(); input.sample();
  expect(callbacks.pause).toHaveBeenCalledTimes(1);
  input.clear(); input.sample(); expect(callbacks.pause).toHaveBeenCalledTimes(1);
  button(controller, 9, 0); input.sample(); button(controller, 9, 1); input.sample();
  expect(callbacks.pause).toHaveBeenCalledTimes(2);
});

it('GAME-05 pressing Start while aiming cannot restore the cancelled aim snapshot', () => {
  const { input, pads, callbacks } = setup(); const controller = pad(); pads([controller]);
  input.onPause = () => { callbacks.pause(); input.clear(); };
  button(controller, 5, 1); input.sample();
  button(controller, 9, 1); input.sample(); expect(input.aiming).toBe(false);
  input.sample(); button(controller, 5, 0); input.sample();
  expect(callbacks.throw).not.toHaveBeenCalled();
});
