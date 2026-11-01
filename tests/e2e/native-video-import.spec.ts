import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('Windows prepares a real oversized synthetic MP4 through isolated upload and mock extraction',async({page})=>{
  test.skip(process.platform!=='win32','Windows MediaTranscoder integration is a separate platform check.');
  test.setTimeout(120_000);
  const directory=join(process.cwd(),'tmp','validation','native-video-import');mkdirSync(directory,{recursive:true});
  const source=readFileSync(join(process.cwd(),'tests','fixtures','materials','synthetic-h264-aac.mp4'));
  // A valid ISO-BMFF free box exercises the >32 MiB upload path without private
  // media or a long real-time recording. This does not test two-hour capacity.
  const padding=Buffer.alloc(33*1024*1024-source.length);padding.writeUInt32BE(padding.length,0);padding.write('free',4,'ascii');
  const oversized=Buffer.concat([source,padding]),filename='synthetic-33MiB.mp4',path=join(directory,filename);
  writeFileSync(path,oversized);const checksum=createHash('sha256').update(oversized).digest('hex');
  await page.goto('/');await page.getByLabel('工作邮箱').fill('advisor1@aeconn.example');await page.getByLabel('密码').fill('AeconnDemo!2026');await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('button',{name:'退出'})).toBeVisible();
  const caseId=await page.evaluate(async()=>{
    const boot=await fetch('/api/bootstrap').then(response=>response.json());const caseId='case-6';
    for(const action of ['generateReport','submitReview']){
      const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':boot.csrf},body:JSON.stringify({action,caseId})});
      if(!response.ok)throw new Error((await response.json()).error);
    }
    return caseId;
  });
  await page.getByRole('button',{name:'退出'}).click();await page.getByLabel('工作邮箱').fill('charles@aeconn.example');await page.getByLabel('密码').fill('AeconnDemo!2026');await page.getByRole('button',{name:'登录工作台'}).click();
  await page.getByRole('button',{name:'资料库',exact:true}).click();
  await page.getByLabel('关联复核案例').selectOption(caseId);await page.getByLabel('资料名称').fill('原生大视频合成验证');await page.getByLabel('来源说明').fill('合成画面和音调，33 MiB 容器填充，仅验证本机流程。');
  await page.getByLabel('图片或视频').setInputFiles(path);await page.getByLabel(/我确认有权处理这份资料/).check();await page.getByRole('button',{name:'上传并自动提取'}).click();
  await expect(page.getByText('大视频已分成 1 段送入提取；提取完成后请逐段复核。')).toBeVisible({timeout:90_000});
  await page.getByRole('button',{name:/原生大视频合成验证（第1\/1段）/}).click();
  await expect(page.getByText('待复核',{exact:true}).first()).toBeVisible({timeout:15_000});
  await expect(page.getByLabel('AI 原始提取')).toHaveValue(/模拟/);
  await expect(page.getByText(new RegExp(`源文件 SHA-256：${checksum}`))).toBeVisible();
  const result=await page.evaluate(async()=>{
    const jobs=await fetch('/api/material-imports').then(response=>response.json());
    const job=jobs.items.find((item:{title:string})=>item.title==='原生大视频合成验证');
    const detail=await fetch(`/api/materials?id=${encodeURIComponent(job.segments[0].materialId)}`).then(response=>response.json());
    return {job,detail};
  });
  expect(result.job.state).toBe('completed');expect(result.job.sourceHash).toBe(checksum);
  expect(result.job.receivedChunks).toBe(5);expect(result.job.segments).toHaveLength(1);
  expect(result.detail.state).toBe('needs_review');expect(result.detail.scope??'case').toBe('case');
  expect(result.detail.importSource.jobId).toBe(result.job.id);expect(result.detail.parts.every((part:{state:string})=>part.state==='done')).toBe(true);
  await page.screenshot({path:join(directory,'native-prepared-review.png'),fullPage:true});
  writeFileSync(join(directory,'result.json'),JSON.stringify({sourceBytes:oversized.length,sourceHash:checksum,durationSeconds:result.job.durationSeconds,outputBytes:result.job.segments[0].bytes,jobState:result.job.state,materialState:result.detail.state,provider:result.detail.provider,scope:result.detail.scope??'case'},null,2));
});
