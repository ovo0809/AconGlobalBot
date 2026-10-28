import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** A local SQLite transaction prevents two servers from recovering/running the same queue. */
export function acquireRuntimeLock(databasePath:string):()=>void {
  const path=resolve(databasePath)+'.runtime.sqlite';
  mkdirSync(dirname(path),{recursive:true});
  const lock=new DatabaseSync(path);const token=randomUUID();
  try{
    lock.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL); BEGIN IMMEDIATE');
    const owner=lock.prepare('SELECT pid FROM owner WHERE id=1').get();
    if(owner){let alive=true;try{process.kill(Number(owner.pid),0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}if(alive)throw new Error('Another Aeconn process already owns this database.');}
    lock.prepare('INSERT INTO owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(process.pid,token);
    lock.exec('COMMIT');
  }catch(error){try{lock.exec('ROLLBACK');}catch{}lock.close();throw error;}
  let released=false;
  return ()=>{if(released)return;released=true;try{lock.prepare('DELETE FROM owner WHERE token=?').run(token);}finally{lock.close();}};
}
