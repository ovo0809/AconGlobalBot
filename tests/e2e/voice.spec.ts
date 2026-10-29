import {expect,test,type Page} from '@playwright/test';

test.use({
  permissions:['microphone'],
  launchOptions:{args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']},
});

const createdAt='2026-10-28T12:00:00.000Z';
function clientBootstrap(){return {
  csrf:'voice-csrf',mode:'client',user:null,clients:[],cases:[],
  activeCase:{id:'case-voice',clientId:'',ownerAgentId:'',status:'interviewing',entry:'life',createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0},
  messages:[],facts:[],reports:[],notifications:[],reviews:[],clientSession:{id:'session-voice',state:'active',entry:'life'},
  capabilities:{analysis:'openai（未完成真实服务验收）',interview:'云端 AI 访谈（待真实验收）',voice:'openai（待真机验证）',voiceConfigured:true,mail:'dry-run（未发送）'},demo:true,
};}

async function stubClient(page:Page){
  const payload=clientBootstrap();
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)}));
  await page.route('**/api/action',async route=>{
    const body=route.request().postDataJSON() as {action?:string};
    if(body.action==='voiceToken')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,token:'synthetic-voice-token'})});
    if(body.action==='pause')payload.clientSession.state='paused';
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
  });
  return payload;
}

test('production CSP rejects blob AudioWorklet modules',async({page})=>{
  await stubClient(page);const response=await page.goto('/');
  const csp=response?.headers()['content-security-policy']??'';expect(csp).toContain("script-src 'self'");expect(csp).not.toMatch(/script-src[^;]*blob:/);
  const result=await page.evaluate(async()=>{
    const context=new AudioContext();const url=URL.createObjectURL(new Blob(["registerProcessor('csp-blob-probe',class extends AudioWorkletProcessor{process(){return true}})"],{type:'text/javascript'}));
    try{await context.audioWorklet.addModule(url);return {loaded:true,message:''};}catch(error){return {loaded:false,message:error instanceof Error?error.message:String(error)};}finally{URL.revokeObjectURL(url);await context.close();}
  });
  expect(result.loaded).toBe(false);expect(result.message).toBeTruthy();
});

test('same-origin capture worklet sends fake microphone PCM, receives captions and releases resources',async({page})=>{
  await stubClient(page);const browserMessages:Record<string,unknown>[]=[];
  const consoleErrors:string[]=[];page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.addInitScript(()=>{
    const state={getUserMediaCalls:0,stoppedTracks:0,closedContexts:0};Object.defineProperty(window,'__voiceTest',{value:state});
    const originalGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{state.getUserMediaCalls+=1;const stream=await originalGetUserMedia(constraints);for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{state.stoppedTracks+=1;stop();};}return stream;};
    const originalClose=AudioContext.prototype.close;AudioContext.prototype.close=function(){state.closedContexts+=1;return originalClose.call(this);};
  });
  await page.routeWebSocket(/\/voice\?token=/,socket=>{
    socket.send(JSON.stringify({type:'ready',inputSampleRate:24_000,outputSampleRate:24_000}));let sentCaption=false;
    socket.onMessage(message=>{const event=JSON.parse(String(message)) as Record<string,unknown>;browserMessages.push(event);if(typeof event.audio==='string'&&!sentCaption){sentCaption=true;socket.send(JSON.stringify({type:'transcript',role:'user',text:'假麦克风字幕',final:true}));socket.send(JSON.stringify({type:'turnComplete'}));}});
  });
  await page.goto('/');
  const workletResponse=await page.evaluate(async()=>{const response=await fetch('/audio/aeconn-capture.js');return {status:response.status,contentType:response.headers.get('content-type')??''};});
  expect(workletResponse.status).toBe(200);expect(workletResponse.contentType).toMatch(/javascript/);
  await page.getByRole('button',{name:'开始连续语音对话'}).click();
  await expect(page.getByText('正在听您说',{exact:true}).first()).toBeVisible();await expect.poll(()=>browserMessages.some(message=>typeof message.audio==='string')).toBe(true);
  await expect(page.getByText('假麦克风字幕')).toBeVisible();
  await page.getByRole('button',{name:'暂停访谈'}).click();await expect(page.getByText('访谈已暂停',{exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__voiceTest:{stoppedTracks:number}}).__voiceTest.stoppedTracks)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>(window as unknown as {__voiceTest:{getUserMediaCalls:number;closedContexts:number}}).__voiceTest)).toMatchObject({getUserMediaCalls:1,closedContexts:expect.any(Number)});
  expect(await page.evaluate(()=>(window as unknown as {__voiceTest:{closedContexts:number}}).__voiceTest.closedContexts)).toBeGreaterThan(0);
  expect(browserMessages.some(message=>message.audioStreamEnd===true)).toBe(true);expect(consoleErrors.filter(message=>/Content Security Policy|audio worklet/i.test(message))).toEqual([]);
});

