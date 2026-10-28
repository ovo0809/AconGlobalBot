import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const source=process.argv[2],target=process.argv[3];
if(!source||!target)throw new Error('用法：npm run restore -- <备份文件> <新的数据库文件>。恢复后设置 DATABASE_PATH 指向新文件。');
const from=resolve(source),to=resolve(target);
if(!existsSync(from)||existsSync(to)||from===to)throw new Error('源文件必须存在，目标必须是一个尚不存在的新文件。');
mkdirSync(dirname(to),{recursive:true});
const database=new DatabaseSync(from,{readOnly:true});
try{if(database.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('备份完整性错误，未恢复。');if(database.prepare('PRAGMA user_version').get()?.user_version!==1)throw new Error('不支持此数据库版本，请先匹配应用版本。');await backup(database,to);console.log(`已恢复到新数据库：${to}。停止旧服务，修改 DATABASE_PATH，然后启动并验证权限、案例、报告和版本。`);}finally{database.close();}
