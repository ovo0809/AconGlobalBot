import {expect,test} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const createdAt='2026-10-31T20:00:00.000Z';
const reviewer={id:'reviewer-import',name:'Charles',email:'reviewer-import@example.invalid',role:'reviewer' as const,orgId:'org-import',emailVerified:true};
const caseRecord={id:'case-import',clientId:'client-import',ownerAgentId:'advisor-import',status:'pending_review',entry:'ltc' as const,createdAt,updatedAt:createdAt,assignedReviewerId:reviewer.id,reportVersion:1,clientName:'大视频测试客户',caseNumber:1};
const video=readFileSync(join(process.cwd(),'tests','fixtures','materials','synthetic-audio-video.webm'));
const bootstrap=()=>({csrf:'import-csrf',mode:'advisor',user:reviewer,clients:[],cases:[caseRecord],deletedCases:[],activeCase:caseRecord,messages:[],facts:[],reports:[],notifications:[],reviews:[],settings:{companyEmail:'company@example.invalid',companyVerified:true,unreviewedSendPolicy:'pending',mailMode:'dry_run'},capabilities:{analysis:'mock',interview:'mock',voice:'mock',voiceConfigured:false,mail:'dry-run'},demo:true,publicAccess:false,sharedDemo:false});

function material(id:string,title:string){return{id,title,filename:'part-000.mp4',kind:'video',state:'needs_review',provider:'mock',caseId:caseRecord.id,createdAt,updatedAt:createdAt,version:1,error:null,scope:'case'};}
function importJob(state:string,materialId?:string){return{id:'12345678-1234-1234-1234-123456789abc',requestId:'87654321-4321-4321-4321-cba987654321',title:'长视频培训资料',sourceNote:'合成大视频来源',caseId:caseRecord.id,filename:'large-training.webm',size:33*1024*1024,lastModified:1_793_462_400_000,state,receivedChunks:state==='uploading'?0:5,totalChunks:5,durationSeconds:3.06,sourceHash:'a'.repeat(64),segments:state==='uploading'||state==='queued'||state==='preparing'?[]:[{index:0,filename:'part-000.mp4',startSeconds:0,endSeconds:3.06,bytes:video.length,sha256:'b'.repeat(64),materialId}],error:null,createdAt,updatedAt:createdAt};}

async function stubPage(page:import('@playwright/test').Page,initial:'none'|'ready'){
  let job=initial==='ready'?importJob('ready'):null,materialItem:ReturnType<typeof material>|null=null;
  const seen={chunks:0,source:'',requestId:''};
  await page.route('**/api/bootstrap*',route=>route.fulfill({json:bootstrap()}));
  await page.route('**/api/material-imports*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==='GET'&&url.searchParams.has('segment'))return route.fulfill({contentType:'video/mp4',body:video});
    if(request.method()==='GET'&&url.searchParams.has('id')){if(job?.state==='queued'||job?.state==='preparing')job=importJob('ready');return route.fulfill({json:job});}
    if(request.method()==='GET')return route.fulfill({json:{available:true,items:job?[job]:[]}});
    if(request.method()==='PUT'){seen.chunks+=1;job={...(job??importJob('uploading')),receivedChunks:seen.chunks};return route.fulfill({json:job});}
    const input=request.postDataJSON() as {action:string;materialId?:string;lastModified?:number};
    if(input.action==='start')job={...importJob('uploading'),filename:'large-training.mp4',lastModified:input.lastModified!};
    if(input.action==='prepare')job=importJob('queued');
    if(input.action==='ack')job=importJob('ready',input.materialId);
    if(input.action==='complete')job=importJob('completed',job?.segments[0]?.materialId);
    if(input.action==='retry')job=importJob('queued');
    if(input.action==='cancel')job={...importJob('cancelled'),segments:[]};
    return route.fulfill({json:job});
  });
  await page.route('**/api/materials*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==='GET'&&url.searchParams.has('id'))return route.fulfill({json:{...materialItem,sourceNote:'合成大视频来源',originalText:'【模拟提取】',reviewedText:'',coverage:'合成视频',events:[],parts:[]}});
    if(request.method()==='GET')return route.fulfill({json:{items:materialItem?[materialItem]:[],provider:'mock',configured:true}});
    const body=request.postDataBuffer()!;seen.source=body.toString('utf8').match(/\{"jobId"[^\r\n]+/)?.[0]??'';seen.requestId=body.toString('utf8').match(/12345678-1234-1234-1234-123456789abc-0/)?.[0]??'';materialItem=material('material-import-0','长视频培训资料（第1/1段）');return route.fulfill({status:201,json:materialItem});
  });
  return seen;
}

test('Charles selects one oversized video and the Demo uploads, prepares and submits its segment',async({page})=>{
  const seen=await stubPage(page,'none');await page.goto('/');await page.getByRole('button',{name:'资料库'}).click();
  await page.getByLabel('资料名称').fill('长视频培训资料');await page.getByLabel('来源说明').fill('合成大视频来源');
  const oversized=Buffer.concat([video,Buffer.alloc(33*1024*1024-video.length)]);
  await page.getByLabel('图片或视频').setInputFiles({name:'large-training.mp4',mimeType:'video/mp4',buffer:oversized});
  await page.getByLabel(/我确认有权处理这份资料/).check();await page.getByRole('button',{name:'上传并自动提取'}).click();
  await expect(page.getByText(/大视频已分成 1 段送入提取/)).toBeVisible({timeout:25_000});expect(seen.chunks).toBe(5);expect(seen.source).toContain('"jobId":"12345678-1234-1234-1234-123456789abc"');expect(seen.source).toContain('"index":0');expect(seen.requestId).toContain('-0');
  await expect(page.getByText(/已送入提取 1 段，等待逐段复核/)).toBeVisible();
});

test('a prepared large-video job can continue after refreshing without selecting the source again',async({page})=>{
  const seen=await stubPage(page,'ready');await page.goto('/');await page.getByRole('button',{name:'资料库'}).click();
  await expect(page.getByText('大视频处理进度')).toBeVisible();await page.getByRole('button',{name:'继续处理'}).click();
  await expect(page.getByText(/大视频已分成 1 段送入提取/)).toBeVisible({timeout:20_000});expect(seen.chunks).toBe(0);expect(seen.source).toContain('"index":0');
});

test('oversized WebM is rejected before any upload chunks are sent',async({page})=>{
  const seen=await stubPage(page,'none');await page.goto('/');await page.getByRole('button',{name:'资料库'}).click();
  await page.getByLabel('资料名称').fill('格式检查');
  await page.getByLabel('图片或视频').setInputFiles({name:'large.webm',mimeType:'video/webm',buffer:Buffer.concat([video,Buffer.alloc(33*1024*1024-video.length)])});
  await page.getByLabel(/我确认有权处理这份资料/).check();await page.getByRole('button',{name:'上传并自动提取'}).click();
  await expect(page.getByRole('status')).toContainText('大视频自动处理支持 MP4、MOV、M4V');expect(seen.chunks).toBe(0);
});

test('cancelling while task creation is in flight cancels the created server task',async({page})=>{
  await stubPage(page,'none');let release!:()=>void,created=false,cancelled=false;
  const delay=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/material-imports',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const body=route.request().postDataJSON() as {action:string;lastModified:number};
    if(body.action==='start'){created=true;await delay;return route.fulfill({json:{...importJob('uploading'),filename:'large-training.mp4',lastModified:body.lastModified}});}
    if(body.action==='cancel')cancelled=true;
    return route.fallback();
  });
  await page.goto('/');await page.getByRole('button',{name:'资料库'}).click();await page.getByLabel('资料名称').fill('延迟取消');
  await page.getByLabel('图片或视频').setInputFiles({name:'large-training.mp4',mimeType:'video/mp4',buffer:Buffer.concat([video,Buffer.alloc(33*1024*1024-video.length)])});
  await page.getByLabel(/我确认有权处理这份资料/).check();await page.getByRole('button',{name:'上传并自动提取'}).click();
  await expect.poll(()=>created).toBe(true);await page.getByRole('button',{name:'取消',exact:true}).click();release();
  await expect.poll(()=>cancelled).toBe(true);await expect(page.getByText('已停止大视频处理；已经送入提取的分段仍保留。')).toBeVisible();
});
