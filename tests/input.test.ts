import { afterEach, expect, it, vi } from 'vitest';
import { Input } from '../src/input';

afterEach(()=>vi.unstubAllGlobals());
it('focus loss is idempotent and cannot toggle pause back to running or release a held projectile',()=>{
  const windowTarget=new EventTarget();
  const documentTarget=Object.assign(new EventTarget(),{hidden:true});
  vi.stubGlobal('window',windowTarget);vi.stubGlobal('document',documentTarget);
  vi.stubGlobal('navigator',{getGamepads:()=>[]});
  const input=new Input();let phase='race';let throws=0;let toggleCalls=0;
  input.onPause=()=>{toggleCalls++;phase=phase==='paused'?'race':'paused';};
  input.onDeactivate=()=>{phase='paused';};input.onThrow=()=>throws++;
  const down=new Event('keydown');Object.assign(down,{code:'Space',repeat:false});
  windowTarget.dispatchEvent(down);input.sample();expect(input.aiming).toBe(true);
  windowTarget.dispatchEvent(new Event('blur'));
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  windowTarget.dispatchEvent(new Event('gamepaddisconnected'));
  input.sample();expect(phase).toBe('paused');expect(toggleCalls).toBe(0);expect(throws).toBe(0);expect(input.aiming).toBe(false);
});
