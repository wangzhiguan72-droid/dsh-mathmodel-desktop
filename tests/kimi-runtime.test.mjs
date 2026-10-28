import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureKimiBridge} from '../src/kimi-bridge.cjs';
test('Kimi bridge uses existing connected daemon without spawning',async()=>{
 let starts=0;
 const state=await ensureKimiBridge({platform:'win32',resourcesRoot:'fixture',status:async()=>({running:true,extension_connected:true}),exists:()=>true,start:async()=>{starts++}});
 assert.equal(state.extension_connected,true);assert.equal(starts,0);
});
test('Kimi bridge starts bundled daemon and preserves disconnected extension status',async()=>{
 let probes=0,executable;
 const state=await ensureKimiBridge({platform:'win32',resourcesRoot:'fixture',status:async()=>++probes===1?null:{running:true,extension_connected:false},exists:()=>true,start:async p=>{executable=p}});
 assert.match(executable,/kimi-webbridge.exe$/);assert.equal(state.extension_connected,false);
});
