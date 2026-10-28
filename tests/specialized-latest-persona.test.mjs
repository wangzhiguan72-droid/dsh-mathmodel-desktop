import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {restoreSpecializedPresets} from '../scripts/restore-specialized-presets.mjs';
test('latest specialized presets retain their persona without removed cwd template',()=>{
 const runtimeRoot=path.resolve('runtime/host/node_modules');
 const require=createRequire(path.join(runtimeRoot,'__probe.cjs')),yaml=require('yaml');
 const text=restoreSpecializedPresets({runtimeRoot}).yaml;
 const rows=yaml.parse(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:v=>v}]}).flatMap(r=>r.insert??[]);
 const persona=rows.find(r=>r.config.id==='mathmodel').config.plugins.find(r=>r.id==='persona');
 assert.match(persona.config.suffix,/Never fabricate data/);
 assert.doesNotMatch(text,/\{\{cwd\}\}/);
});
