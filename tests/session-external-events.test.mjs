import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { patchSessionExternalEvents, patchSessionExternalEventsSource } from '../scripts/patch-session-external-events.mjs';
import { appendMathmodelRecord, mathmodelRecordType } from '../plugins/dsh-mathmodel/src/session-records.js';
const runtimeRoot = path.resolve(import.meta.dirname, '../resources/runtime/host/node_modules');
const load = name => import(pathToFileURL(path.join(runtimeRoot, '@deepseek-ai', name, 'lib/index.js')).href);

test('legacy append patch remains guarded; v4 kernel stays byte-identical', () => {
 const source = ['append(type, data, ...opts) {', 'const surfaceOpts = opts[0];', '\t\tconst surfaceMetadata = {', '\t\t\t...surfaceOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },', '\t\t\t...surfaceOpts?.surfaceOp === void 0 ? {} : { surfaceOp: surfaceOpts.surfaceOp }', '\t\t};'].join('\n');
 const once = patchSessionExternalEventsSource(source);
 assert.equal(patchSessionExternalEventsSource(once), once);
 assert.match(once, /ignorable === true/);
 assert.throws(() => patchSessionExternalEventsSource(source.replace('opts[0]', 'opts.at(0)')), /shape changed/);
 const file=path.join(runtimeRoot,'@deepseek-ai/dsh-session/lib/index.js'); const before=fs.readFileSync(file);
 assert.equal(patchSessionExternalEvents({runtimeRoot}).nativePluginRecords,true);
 assert.deepEqual(fs.readFileSync(file),before);
});

test('real v4 Session writes and restores ignorable mathmodel plugin records', async () => {
 const {Session,pluginRecordOf} = await load('dsh-session');
 const session=Session.create('v4-mathmodel-fixture'); assert.equal(session.header.version,4);
 appendMathmodelRecord(session,'mathmodel/capabilities-confirmed',{schema:1});
 const events=session.snapshotEvents(); assert.equal(events[0].ignorable,true);
 assert.equal(events[0].type,'plugin:mathmodel/capabilities-confirmed');
 assert.deepEqual(pluginRecordOf(events[0]).data,{schema:1});
 const restored=Session.fromRestore(session.id,structuredClone(events),session.header,0,'snapshot');
 assert.equal(mathmodelRecordType(restored.eventAt(0)),'mathmodel/capabilities-confirmed');
 assert.throws(()=>appendMathmodelRecord(session,'other/record',{}),/Invalid/);
});

test('official v3 to v4 migration preserves legacy mathmodel records', async () => {
 const {createSessionFormatChain}=await load('dsh-session-format');
 const {createSessionFormatV3ToV4,assertReleasedV4Header,restoreReleasedV4Artifact}=await load('dsh-session-format-v3-to-v4');
 const migrations = await Promise.all([0,1,2].map(async n => (await load('dsh-session-format-v'+n+'-to-v'+(n+1)))['sessionFormatV'+n+'ToV'+(n+1)]));
 const header={version:3,id:'legacy-mathmodel-fixture',createdAt:1,isSeeded:false,delegationDepth:0};
 const events=[]; const chain=createSessionFormatChain({currentVersion:4,migrations:[...migrations,createSessionFormatV3ToV4([])],restoreCurrentHeader:h=>{assertReleasedV4Header(h);return h;}});
 const stream=chain.createStream(header,0,{emitEvent:e=>events.push(e),emitRun:run=>events.push(...run.expand())});
 stream.emitEvent({type:'mathmodel/capabilities-confirmed',seq:0,time:1,data:{schema:1},ignorable:true});
 const inheritedEventCount=stream.finish();
 const {KNOWN_SESSION_EVENT_TYPES}=await load('dsh-session');
 const restored=restoreReleasedV4Artifact({header:stream.header,inheritedEventCount,events},KNOWN_SESSION_EVENT_TYPES);
 assert.equal(restored.header.version,4); assert.equal(restored.events[0].type,'plugin:mathmodel/capabilities-confirmed');
 assert.equal(mathmodelRecordType(restored.events[0]),'mathmodel/capabilities-confirmed'); assert.deepEqual(restored.events[0].data,{schema:1});
});
