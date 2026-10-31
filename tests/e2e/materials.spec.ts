import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const createdAt='2026-10-30T20:00:00.000Z';
const advisor={id:'advisor-material',name:'林顾问',email:'advisor-material@example.invalid',role:'advisor' as const,orgId:'org-material',emailVerified:true};
const caseRecord={id:'case-material',clientId:'client-material',ownerAgentId:advisor.id,status:'draft',entry:'ltc' as const,createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0,clientName:'资料测试客户',caseNumber:1};
const screenshotDirectory=join(process.cwd(),'tmp','validation','materials');
const png=readFileSync(join(process.cwd(),'docs','screenshots','client-mobile-390x844.png'));
test.beforeAll(()=>mkdirSync(screenshotDirectory,{recursive:true}));

function bootstrap(){return{csrf:'material-csrf',mode:'advisor',user:advisor,clients:[],cases:[caseRecord],deletedCases:[],activeCase:caseRecord,messages:[],facts:[],reports:[],notifications:[],reviews:[],settings:{companyEmail:'company@example.invalid',companyVerified:true,unreviewedSendPolicy:'pending',mailMode:'dry_run'},capabilities:{analysis:'mock',interview:'mock',voice:'mock',voiceConfigured:false,mail:'dry-run'},demo:true,publicAccess:false,sharedDemo:false};}

test('advisor uploads, reviews, approves and withdraws extracted image material',async({page})=>{
  let state:'none'|'needs_review'|'approved'|'withdrawn'='none',version=1;
  const summary=()=>({id:'material-1',title:'长期护理海报',filename:'poster.png',kind:'image',state:state==='none'?'needs_review':state,provider:'mock',caseId:caseRecord.id,createdAt,updatedAt:createdAt,version,error:null,scope:'case'});
  const detail=()=>({...summary(),sourceNote:'公开合成示例',originalText:'【模拟提取】长期护理资料待人工核对。',reviewedText:'长期护理资料待人工核对。',coverage:'图片完整画面；模拟模式不代表真实 OCR。',events:[{at:createdAt,action:'extracted',detail:'模拟提取完成'}],parts:[{kind:'image',position:0,startSeconds:0,endSeconds:0,state:'done',text:'长期护理资料待人工核对。'}]});
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(bootstrap())}));
  await page.route('**/api/materials*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==='GET'&&url.searchParams.get('original')==='1')return route.fulfill({status:200,contentType:'image/png',body:png});
    if(request.method()==='GET'&&url.searchParams.get('id'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail())});
    if(request.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:state==='none'?[]:[summary()],provider:'mock',configured:true})});
    if(request.headers()['content-type']?.startsWith('multipart/form-data')){state='needs_review';return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify(summary())});}
    const input=request.postDataJSON() as {action:string};version+=1;state=input.action==='approve'?'approved':input.action==='withdraw'?'withdrawn':state;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail())});
  });
  await page.goto('/');await page.getByRole('button',{name:'资料库'}).click();
  await expect(page.getByRole('heading',{name:'上传参考资料'})).toBeVisible();
  await page.getByLabel('资料名称').fill('长期护理海报');await page.getByLabel('来源说明').fill('公开合成示例');
  await page.getByLabel('图片或视频').evaluate(async(input:HTMLInputElement)=>{const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;const context=canvas.getContext('2d')!;context.fillStyle='#203b34';context.fillRect(0,0,120,80);context.fillStyle='#fff';context.fillText('Aeconn',20,40);const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('fixture image failed')),'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'poster.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.getByText('我确认有权处理这份资料').click();await page.getByRole('button',{name:'上传并自动提取'}).click();
  await expect(page.getByText('资料已上传，提取完成后需要人工复核。')).toBeVisible();await expect(page.getByRole('heading',{name:'长期护理海报'})).toBeVisible();await page.screenshot({path:join(screenshotDirectory,'library-desktop-1440.png'),fullPage:true});
  await page.getByText('已核对原资料及提取范围').click();await page.getByRole('button',{name:'复核通过并允许 AI 参考'}).click();await expect(page.getByText('资料已复核，之后可供 AI 参考。')).toBeVisible();
  await page.getByRole('button',{name:'撤回参考资格'}).click();await expect(page.getByText('资料已撤回，不再供 AI 参考。')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('material library remains usable at 390px without horizontal overflow',async({page})=>{
  const item={id:'material-mobile',title:'手机复核资料',filename:'mobile.png',kind:'image',state:'needs_review',provider:'mock',caseId:caseRecord.id,createdAt,updatedAt:createdAt,version:1,error:null,scope:'case'};
  const detail={...item,sourceNote:'合成资料',originalText:'待复核文字',reviewedText:'待复核文字',coverage:'完整图片',events:[],parts:[{kind:'image',position:0,startSeconds:0,endSeconds:0,state:'done',text:'待复核文字'}]};
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(bootstrap())}));
  await page.route('**/api/materials*',route=>{const url=new URL(route.request().url());if(url.searchParams.get('original')==='1')return route.fulfill({status:200,contentType:'image/png',body:png});if(url.searchParams.get('id'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail)});return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[item],provider:'mock',configured:true})});});
  await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByRole('button',{name:'资料库'}).click();
  await expect(page.getByRole('heading',{name:'上传参考资料'})).toBeVisible();await page.getByRole('button',{name:/手机复核资料/}).click();await expect(page.getByRole('heading',{name:'手机复核资料'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:join(screenshotDirectory,'library-mobile-390.png'),fullPage:true});
});

for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  test(`material library scrolls with the wheel and exposes bottom review controls at ${viewport.width}px`,async({page})=>{
    const item={id:'material-scroll',title:'滚动检查资料',filename:'scroll.png',kind:'image',state:'needs_review',provider:'mock',caseId:caseRecord.id,createdAt,updatedAt:createdAt,version:1,error:null,scope:'case'};
    const detail={...item,sourceNote:'合成滚动检查',originalText:'待核对文字',reviewedText:'待核对文字',coverage:'合成图片',events:[{at:createdAt,action:'extracted',detail:'滚动检查记录末尾'}],parts:[]};
    await page.route('**/api/bootstrap*',route=>route.fulfill({json:bootstrap()}));
    await page.route('**/api/materials*',route=>{const url=new URL(route.request().url());if(url.searchParams.get('original')==='1')return route.fulfill({contentType:'image/png',body:png});return route.fulfill({json:url.searchParams.get('id')?detail:{items:[item],provider:'mock',configured:true}});});
    await page.setViewportSize(viewport);await page.goto('/');await page.getByRole('button',{name:'资料库',exact:true}).click();await page.getByRole('button',{name:/滚动检查资料/}).click();
    const scrollArea=page.locator('.material-scroll, .workspace:not(:has(.material-scroll))');
    const bounds=(await scrollArea.boundingBox())!;
    // Stay in the outer padding so the wheel does not target a textarea.
    await page.mouse.move(bounds.x+bounds.width-20,bounds.y+bounds.height/2);
    const before=await scrollArea.evaluate(el=>el.scrollTop);await page.mouse.wheel(0,500);
    await expect.poll(()=>scrollArea.evaluate(el=>el.scrollTop)).toBeGreaterThan(before+100);
    await page.mouse.wheel(0,10000);await expect(page.getByText('查看处理记录',{exact:true})).toBeInViewport({ratio:1});
    await page.getByText('查看处理记录',{exact:true}).click();await page.mouse.move(bounds.x+bounds.width-20,bounds.y+bounds.height/2);await page.mouse.wheel(0,10000);await expect(page.getByText(/滚动检查记录末尾/)).toBeInViewport({ratio:1});
    const region=page.getByRole('region',{name:'资料库内容',exact:true});
    await expect(region).toHaveCSS('overflow-y','scroll');await expect(region).toHaveCSS('scrollbar-width','auto');
    expect(await region.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:join(screenshotDirectory,`library-scroll-bottom-${viewport.width}.png`),fullPage:true});
    await region.press('Control+Home');await expect.poll(()=>region.evaluate(el=>el.scrollTop)).toBe(0);
    await expect(page.getByRole('heading',{name:'上传参考资料',exact:true})).toBeInViewport({ratio:1});
  });
}

test('browser prepares a synthetic video with real audio before upload',async({page})=>{
  const videoDetail={id:'material-video',title:'合成视频',filename:'synthetic.webm',kind:'video',state:'needs_review',provider:'mock',caseId:caseRecord.id,createdAt,updatedAt:createdAt,version:1,error:null,scope:'case',sourceNote:'浏览器合成测试',originalText:'【模拟提取】',reviewedText:'',coverage:'音轨与关键画面待复核',events:[],parts:[]};
  let uploaded=false;
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(bootstrap())}));
  await page.route('**/api/materials*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==='GET'&&url.searchParams.get('id'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(videoDetail)});
    if(request.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:uploaded?[videoDetail]:[],provider:'mock',configured:true})});
    uploaded=true;expect(request.headers()['content-type']).toContain('multipart/form-data');expect(request.postDataBuffer()?.byteLength).toBeGreaterThan(1000);return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify(videoDetail)});
  });
  await page.goto('/');await page.getByRole('button',{name:'资料库'}).click();await page.getByLabel('资料名称').fill('合成视频');await page.getByLabel('来源说明').fill('浏览器合成测试');
  await page.getByLabel('图片或视频').evaluate(async(input:HTMLInputElement)=>{
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const drawing=canvas.getContext('2d')!;
    const audio=new AudioContext(),destination=audio.createMediaStreamDestination(),oscillator=audio.createOscillator();oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();
    const stream=new MediaStream([...canvas.captureStream(12).getVideoTracks(),...destination.stream.getAudioTracks()]);
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks:Blob[]=[];recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    const stopped=new Promise<void>(resolve=>recorder.onstop=()=>resolve());recorder.start(100);let frame=0;const timer=window.setInterval(()=>{drawing.fillStyle=frame++%2?'#203b34':'#a18047';drawing.fillRect(0,0,canvas.width,canvas.height);},50);await new Promise(resolve=>window.setTimeout(resolve,1100));recorder.stop();await stopped;window.clearInterval(timer);oscillator.stop();stream.getTracks().forEach(track=>track.stop());await audio.close();
    const file=new File(chunks,'synthetic.webm',{type:'video/webm'}),transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.getByText('我确认有权处理这份资料').click();await page.getByRole('button',{name:'上传并自动提取'}).click();
  await expect(page.getByText('资料已上传，提取完成后需要人工复核。')).toBeVisible({timeout:20_000});expect(uploaded).toBe(true);
});

test('real isolated materials API processes and approves a generated image in mock mode',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'登录工作台'}).click();await expect(page.getByRole('heading',{name:/我的客户/})).toBeVisible();await page.getByRole('button',{name:'资料库'}).click();
  await page.getByLabel('资料名称').fill('真实路由合成海报');await page.getByLabel('来源说明').fill('Playwright 生成的隔离合成图片');
  await page.getByLabel('图片或视频').evaluate(async(input:HTMLInputElement)=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const context=canvas.getContext('2d')!;context.fillStyle='#203b34';context.fillRect(0,0,320,180);context.fillStyle='#f3ead7';context.font='24px sans-serif';context.fillText('Synthetic Aeconn material',20,90);const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('fixture image failed')),'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'synthetic-material.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.getByText('我确认有权处理这份资料').click();await page.getByRole('button',{name:'上传并自动提取'}).click();
  await expect(page.getByRole('heading',{name:'真实路由合成海报'})).toBeVisible();await expect(page.getByText('待复核',{exact:true}).first()).toBeVisible({timeout:15_000});
  const review=page.getByLabel('人工复核稿');await expect(review).toHaveValue(/模拟[\s\S]*提取/);await page.getByText('已核对原资料及提取范围').click();await page.getByRole('button',{name:'复核通过并允许 AI 参考'}).click();
  await expect(page.getByText('资料已复核，之后可供 AI 参考。')).toBeVisible();await expect(page.getByText('仅关联案例',{exact:true})).toBeVisible();await page.getByText('查看处理记录').click();await expect(page.getByText(/画面 0\.0–0\.0 秒/)).toBeVisible();
});
