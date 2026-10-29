import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test.use({permissions:['microphone'],launchOptions:{args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}});

test('会谈录音：假麦克风、暂停刷新、核对来源、后台报告和 PDF', async ({page}) => {
  const requests:string[]=[];
  page.on('websocket', socket=>requests.push(socket.url()));
  await page.addInitScript(()=>{
    const state={starts:0,stops:0};Object.defineProperty(window,'__recordingMedia',{value:state});
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{
      state.starts++;const stream=await original(constraints);
      for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{state.stops++;stop();};}
      return stream;
    };
  });
  await page.goto('/');
  await page.getByLabel('工作邮箱').fill('advisor1@aeconn.example');
  await page.getByLabel('密码').fill('AeconnDemo!2026');
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('button',{name:'退出'})).toBeVisible();
  const caseId=await page.evaluate(async()=>{
    const {csrf}=await fetch('/api/bootstrap').then(r=>r.json());
    const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action:'createClient',name:'会谈录音合成验收',birthday:'1985-01-01',gender:'女性',phone:'+12025550199',email:'recording-e2e@example.invalid',maritalStatus:'已婚',state:'CA',language:'普通话'})});
    if(!response.ok)throw new Error(await response.text());
    return (await response.json()).caseId as string;
  });
  await page.reload();
  await page.locator('.case-item').filter({hasText:'会谈录音合成验收'}).click();
  await page.getByRole('button',{name:'录音转写＋会后报告',exact:true}).click();
  await expect(page.getByRole('button',{name:'开始录音',exact:true})).toBeDisabled();
  await page.getByLabel('客户已知情并同意本次录音与转写').check();
  await page.getByRole('button',{name:'开始录音',exact:true}).click();
  await expect(page.getByRole('button',{name:'暂停并保存'})).toBeVisible();
  await expect(page.locator('.recording-meter')).toContainText('00:02');
  // Other case tabs must not unmount the ongoing recorder.
  await page.getByRole('button',{name:'画像与来源',exact:true}).click();
  await page.getByRole('button',{name:'会谈录音',exact:true}).click();
  await page.getByRole('button',{name:'暂停并保存'}).click();
  await expect(page.locator('.recording-meter')).toContainText('已保存 1 段');
  expect(await page.evaluate(()=>(window as unknown as {__recordingMedia:{starts:number;stops:number}}).__recordingMedia)).toEqual({starts:1,stops:1});
  await page.reload();
  await expect(page.locator('.recording-meter')).toContainText('已保存 1 段');
  await page.getByRole('button',{name:'结束并开始转写'}).click();
  await expect(page.getByRole('heading',{name:'核对转写和说话人'})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__recordingMedia:{starts:number}}).__recordingMedia.starts)).toBe(0);
  expect(requests.filter(url=>/\/voice\?/.test(url))).toEqual([]);
  await expect(page.getByLabel('说话人').first()).toHaveValue('unclear');
  await expect(page.getByRole('button',{name:'确认客户原话并生成报告'})).toBeDisabled();
  await page.getByLabel('说话人').first().selectOption('customer');
  await page.getByLabel('核对后的文字').first().fill('我计划明年开始准备家庭保障。');
  await page.setViewportSize({width:390,height:844});
  await page.locator('.case-item').filter({hasText:'会谈录音合成验收'}).click();
  await expect(page.getByLabel('核对后的文字').first()).toHaveValue('我计划明年开始准备家庭保障。');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByLabel('我已核对说话人和文字；只有客户亲自陈述的内容被标为“客户”').check();
  mkdirSync(join(process.cwd(),'tmp','recording-validation'),{recursive:true});
  await page.screenshot({path:join(process.cwd(),'tmp','recording-validation','review-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'确认客户原话并生成报告'}).click();
  await expect(page.getByText('客户原话已保存，报告正在后台处理',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/内部报告 v1/})).toBeVisible({timeout:30_000});
  const saved=await page.evaluate(async id=>{
    const response=await fetch(`/api/bootstrap?caseId=${id}`).then(r=>r.json());
    const recording=await fetch(`/api/recording?caseId=${id}`).then(r=>r.json());
    const audio=await fetch(`/api/recording?caseId=${id}&audioIndex=0`);
    return {message:response.messages[0],facts:response.facts,job:response.reportJob,recording,audioStatus:audio.status,notifications:response.notifications};
  },caseId);
  expect(saved.message).toMatchObject({sourceKind:'advisor_reviewed_recording',source:'customer',text:'我计划明年开始准备家庭保障。'});
  expect(saved.facts).toEqual([]); // Mock transcribes a fixture; it must not invent extracted client facts.
  expect(saved.job.status).toBe('ready');
  expect(saved.recording.session.state).toBe('confirmed');
  expect(saved.audioStatus).toBe(404);
  expect(saved.notifications).toHaveLength(0);
  await page.getByRole('button',{name:/内部报告 v1/}).click();
  const pdfLink=await page.getByRole('link',{name:'预览 PDF'}).getAttribute('href');
  const pdf=await page.request.get(pdfLink!);
  expect(pdf.status()).toBe(200);expect((await pdf.body()).subarray(0,4).toString()).toBe('%PDF');
});
