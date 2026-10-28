import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
const source=resolve(process.env.DATABASE_PATH||'./data/aeconn.sqlite');
const target=resolve(process.argv[2]||`./data/backups/aeconn-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
if(!existsSync(source))throw new Error('数据库尚不存在，请先启动 Demo。');
if(existsSync(target)||source===target)throw new Error('备份目标已存在；请使用新文件名，避免覆盖。');
mkdirSync(dirname(target),{recursive:true});
const database=new DatabaseSync(source,{readOnly:true});
try{await backup(database,target);const check=new DatabaseSync(target,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('备份完整性校验失败。');}finally{check.close();}console.log(`一致性备份完成（包括数据库内 PDF 和版本）：${target}`);}finally{database.close();}
