import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireRuntimeLock } from '../lib/runtime-lock';

test('runtime ownership prevents a second server and reclaims a crashed process atomically',()=>{
  const root=mkdtempSync(join(tmpdir(),'aeconn-runtime-'));const path=join(root,'app.sqlite');
  try{
    const release=acquireRuntimeLock(path);
    assert.throws(()=>acquireRuntimeLock(path),/already owns/);
    release();release();
    const crashed=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {acquireRuntimeLock} from './lib/runtime-lock.ts'; acquireRuntimeLock(${JSON.stringify(path)}); process.exit(0);`],{encoding:'utf8'});
    assert.equal(crashed.status,0,crashed.stderr);
    const recovered=acquireRuntimeLock(path);recovered();
  }finally{rmSync(root,{recursive:true,force:true});}
});
