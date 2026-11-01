import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const clientId='client-material-seek';
const caseId='case-material-seek';
const materialIds=['material-seek-a','material-seek-b'] as const;
const video=readFileSync(resolve('tests/fixtures/materials/synthetic-h264-aac.mp4'));

function database(){return new DatabaseSync(resolve('tmp/e2e.sqlite'));}
function pack(value:unknown){return JSON.stringify(value);}

test.beforeEach(()=>{
  const db=database(),createdAt='2026-10-31T22:30:00.000Z';
  try{
    const client={id:clientId,name:'视频拖动测试（合成）',birthday:'1985-06-15',gender:'不指定',phone:'+12025550199',email:'seek@example.invalid',maritalStatus:'已婚',state:'CA',language:'普通话',ownerAgentId:'advisor-1',consentStatus:'synthetic_demo',createdAt};
    const caseRecord={id:caseId,clientId,ownerAgentId:'advisor-1',status:'pending_review',entry:'ltc',createdAt,updatedAt:createdAt,assignedReviewerId:'charles',reportVersion:0};
    db.prepare('INSERT INTO clients VALUES(?,?,?)').run(clientId,'advisor-1',pack(client));
    db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(caseId,clientId,'advisor-1','charles',pack(caseRecord));
    for(const [index,id] of materialIds.entries()){
      const document={id,title:`可拖动视频 ${index+1}`,filename:`seek-${index+1}.mp4`,kind:'video',state:'needs_review',provider:'mock',caseId,createdAt,updatedAt:createdAt,version:1,error:null,scope:'case',sourceNote:'浏览器拖动隔离合成视频',originalText:'【模拟提取】',reviewedText:'',coverage:'六秒合成画面和音调；仅用于播放器回归。',events:[]};
      db.prepare('INSERT INTO material_documents VALUES(?,?,?,?,?,?,?,?,?)').run(id,'charles',caseId,`seek-request-${index}`,`seek-fingerprint-${index}`,'needs_review',pack(document),'video/mp4',video);
    }
  } finally {db.close();}
});

test.afterEach(()=>{
  const db=database();
  try{
    for(const id of materialIds)db.prepare('DELETE FROM material_documents WHERE id=?').run(id);
    db.prepare('DELETE FROM cases WHERE id=?').run(caseId);
    db.prepare('DELETE FROM clients WHERE id=?').run(clientId);
  } finally {db.close();}
});

test('reviewer can drag or seek an uploaded video and switching sources resets playback',async({page})=>{
  await page.goto('/');
  await page.getByLabel('工作邮箱').fill('charles@aeconn.example');
  await page.getByLabel('密码').fill('AeconnDemo!2026');
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('button',{name:'资料库',exact:true})).toBeVisible();

  const range=await page.evaluate(async id=>{
    const response=await fetch(`/api/materials?id=${id}&original=1`,{headers:{Range:'bytes=24-63'}});
    return {status:response.status,acceptRanges:response.headers.get('accept-ranges'),contentRange:response.headers.get('content-range'),length:response.headers.get('content-length'),bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};
  },materialIds[0]);
  expect(range).toEqual({status:206,acceptRanges:'bytes',contentRange:`bytes 24-63/${video.length}`,length:'40',bytes:Array.from(video.subarray(24,64))});

  await page.getByRole('button',{name:'资料库',exact:true}).click();
  await page.getByRole('button',{name:/可拖动视频 1/}).click();
  const player=page.getByLabel('资料视频预览');
  await expect(player).toBeVisible();
  await expect.poll(()=>player.evaluate((element:HTMLVideoElement)=>Number.isFinite(element.duration)&&element.duration>5)).toBe(true);

  await expect.poll(()=>player.evaluate((element:HTMLVideoElement)=>element.seekable.length?element.seekable.end(0):0)).toBeGreaterThan(5);
  // Chromium's native controls live in a closed user-agent shadow root, and their
  // slider does not consistently accept synthetic drag events in headless mode.
  // Setting currentTime still exercises the real media seek/demux path, including
  // the server byte-range requests that the visible slider depends on.
  await player.evaluate(async(element:HTMLVideoElement)=>{
    element.currentTime=Math.min(4,element.duration*.7);
    if(element.seeking)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('forward seek timed out')),5000);element.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});});
  });
  await expect.poll(()=>player.evaluate((element:HTMLVideoElement)=>element.seeking?0:element.currentTime)).toBeGreaterThan(1);
  const forward=await player.evaluate((element:HTMLVideoElement)=>element.currentTime);
  await player.evaluate(async(element:HTMLVideoElement)=>{
    element.currentTime=.5;
    if(element.seeking)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('backward seek timed out')),5000);element.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});});
  });
  await expect.poll(()=>player.evaluate((element:HTMLVideoElement)=>element.seeking?Infinity:element.currentTime)).toBeLessThan(forward);

  await page.getByRole('button',{name:/可拖动视频 2/}).click();
  await expect(player).toHaveAttribute('src',new RegExp(`id=${materialIds[1]}`));
  await expect.poll(()=>player.evaluate((element:HTMLVideoElement)=>element.currentTime)).toBeLessThan(0.25);
});
