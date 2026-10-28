import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('SQLite online backup preserves WAL rows, report versions and attachment bytes across restore',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aeconn-backup-'));const source=new DatabaseSync(join(dir,'source.sqlite'));
  try {source.exec('PRAGMA journal_mode=WAL;CREATE TABLE reports(case_id TEXT, version INTEGER, pdf BLOB);');source.prepare('INSERT INTO reports VALUES(?,?,?)').run('case-test',2,Buffer.from('%PDF synthetic attachment'));
    await backup(source,join(dir,'backup.sqlite'));const backed=new DatabaseSync(join(dir,'backup.sqlite'),{readOnly:true});try{await backup(backed,join(dir,'restored.sqlite'));}finally{backed.close();}
    const restored=new DatabaseSync(join(dir,'restored.sqlite'));try{const row=restored.prepare('SELECT * FROM reports').get()!;assert.equal(row.case_id,'case-test');assert.equal(row.version,2);assert.equal(Buffer.from(row.pdf as Uint8Array).toString(),'%PDF synthetic attachment');assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');}finally{restored.close();}
  }finally{source.close();rmSync(dir,{recursive:true,force:true});}
});
