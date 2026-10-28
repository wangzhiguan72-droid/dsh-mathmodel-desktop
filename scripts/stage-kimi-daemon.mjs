import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function stageKimiDaemon(){
 const lock=JSON.parse(fs.readFileSync(path.join(repo,'scripts/kimi-daemon-lock.json'),'utf8'));
 const source=path.join(repo,'runtime/cache/kimi-webbridge-windows-amd64.exe');
 if(createHash('sha256').update(fs.readFileSync(source)).digest('hex')!==lock.sha256)throw new Error('Kimi daemon cache integrity mismatch');
 const output=path.join(repo,'resources/runtime/kimi-webbridge');fs.mkdirSync(output,{recursive:true});
 fs.copyFileSync(source,path.join(output,'kimi-webbridge.exe'));
 fs.writeFileSync(path.join(output,'provenance.json'),JSON.stringify(lock,null,2)+'\n');
}
