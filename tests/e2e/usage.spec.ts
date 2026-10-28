import { expect, test, type Page } from '@playwright/test';

const createdAt='2026-10-28T03:00:00.000Z';

function advisorBootstrap(records:unknown[] = []) {
  const usage={
    limits:{caseMicros:2_000_000,dailyMicros:5_000_000,monthlyMicros:20_000_000},
    dayUtc:'2026-10-28',monthUtc:'2026-10',
    case:{costMicros:records.length?760_000:0,heldMicros:records.length?500_000:0,remainingMicros:records.length?740_000:2_000_000},
    day:{costMicros:records.length?760_000:0,heldMicros:records.length?500_000:0,remainingMicros:records.length?3_740_000:5_000_000},
    month:{costMicros:records.length?760_000:0,heldMicros:records.length?500_000:0,remainingMicros:records.length?18_740_000:20_000_000},
    records,rateCardVersion:'2026-10-28',
  };
  return {
    csrf:'test-csrf',mode:'advisor',user:{id:'advisor-1',name:'林顾问',email:'advisor1@aeconn.example',role:'advisor',orgId:'org-demo',emailVerified:false},
    clients:[{id:'client-1',name:'王芳 · 合成客户',birthday:'1985-06-15',gender:'女性',phone:'+12025550100',email:'client@example.invalid',maritalStatus:'已婚',state:'CA',language:'普通话',ownerAgentId:'advisor-1',consentStatus:'synthetic_demo',createdAt}],
    cases:[{id:'case-1',clientId:'client-1',ownerAgentId:'advisor-1',status:'needs_report',entry:'life',createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0,clientName:'王芳 · 合成客户'}],
    activeCase:{id:'case-1',clientId:'client-1',ownerAgentId:'advisor-1',status:'needs_report',entry:'life',createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0,clientName:'王芳 · 合成客户'},
    messages:[],facts:[],reports:[],notifications:[],reviews:[],capabilities:{analysis:'mock（模拟分析）',interview:'模拟访谈',voice:'实时语音未配置',voiceConfigured:false,mail:'dry-run（未发送）'},demo:true,usage,
  };
}

async function stubBootstrap(page:Page,payload:unknown) {
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)}));
}

async function openUsage(page:Page) {
  await page.goto('/');
  await page.getByRole('button',{name:'费用与用量'}).click();
}

test('模拟模式显示零新增调用与空的付费记录',async({page})=>{
  await stubBootstrap(page,advisorBootstrap());
  await openUsage(page);
  await expect(page.getByText('MOCK · $0 新增调用')).toBeVisible();
  await expect(page.getByText('尚无付费调用记录')).toBeVisible();
  await expect(page.getByText('当前案例')).toBeVisible();
  await expect(page.getByText('上限 $2.00')).toBeVisible();
});

test('费用面板区分已知用量与待核对预留，并适配手机宽度',async({page})=>{
  const records=[{
    id:'usage-1',operation:'realtime',model:'gpt-realtime-2.1',status:'unknown',createdAt,
    costMicros:760_000,reservedMicros:500_000,inputTokens:1200,outputTokens:400,cachedTokens:800,
    inputAudioTokens:4200,outputAudioTokens:3600,transcriptionSeconds:75,
  }];
  await stubBootstrap(page,advisorBootstrap(records));
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await page.getByRole('button',{name:/王芳 · 合成客户/}).click();
  await page.getByRole('button',{name:'费用与用量'}).click();
  await expect(page.getByText('待核对',{exact:true})).toBeVisible();
  await expect(page.getByText('连续语音')).toBeVisible();
  await expect(page.getByText('其中音频 4,200 入 / 3,600 出')).toBeVisible();
  await expect(page.getByText('占用 $0.76')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('客户受限模式不渲染费用与内部用量',async({page})=>{
  const payload={
    csrf:'client-csrf',mode:'client',user:null,clients:[],cases:[],
    activeCase:{id:'case-1',clientId:'',ownerAgentId:'',status:'interviewing',entry:'life',createdAt:'',updatedAt:'',assignedReviewerId:null,reportVersion:0},
    messages:[],facts:[],reports:[],notifications:[],reviews:[],
    clientSession:{id:'session-1',state:'active',entry:null},
    capabilities:{analysis:'mock（模拟分析）',interview:'模拟访谈',voice:'实时语音未配置',voiceConfigured:false,mail:'dry-run（未发送）'},
    demo:true,
    usage:advisorBootstrap([]).usage,
  };
  await stubBootstrap(page,payload);
  await page.goto('/');
  await expect(page.getByText('受限客户模式')).toBeVisible();
  await expect(page.getByRole('button',{name:'费用与用量'})).toHaveCount(0);
  await expect(page.getByText('应用级支出保护')).toHaveCount(0);
});
