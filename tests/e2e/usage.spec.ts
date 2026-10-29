import { expect, test, type Page } from '@playwright/test';

const createdAt='2026-10-28T03:00:00.000Z';

function advisorBootstrap() {
  return {
    csrf:'test-csrf',mode:'advisor',user:{id:'advisor-1',name:'林顾问',email:'advisor1@aeconn.example',role:'advisor',orgId:'org-demo',emailVerified:false},
    clients:[{id:'client-1',name:'王芳 · 合成客户',birthday:'1985-06-15',gender:'女性',phone:'+12025550100',email:'client@example.invalid',maritalStatus:'已婚',state:'CA',language:'普通话',ownerAgentId:'advisor-1',consentStatus:'synthetic_demo',createdAt}],
    cases:[{id:'case-1',clientId:'client-1',ownerAgentId:'advisor-1',status:'needs_report',entry:'life',createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0,clientName:'王芳 · 合成客户'}],
    activeCase:{id:'case-1',clientId:'client-1',ownerAgentId:'advisor-1',status:'needs_report',entry:'life',createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0,clientName:'王芳 · 合成客户'},
    messages:[],facts:[],reports:[],notifications:[],reviews:[],capabilities:{analysis:'mock（模拟分析）',interview:'模拟访谈',voice:'实时语音未配置',voiceConfigured:false,mail:'dry-run（未发送）'},demo:true,
    usage:{
      limits:{caseMicros:2_000_000,dailyMicros:5_000_000,monthlyMicros:20_000_000},dayUtc:'2026-10-28',monthUtc:'2026-10',
      case:{costMicros:760_000,heldMicros:500_000,remainingMicros:740_000},day:{costMicros:760_000,heldMicros:500_000,remainingMicros:3_740_000},month:{costMicros:760_000,heldMicros:500_000,remainingMicros:18_740_000},
      records:[{id:'usage-1',operation:'realtime',model:'gpt-realtime-2.1',status:'unknown',createdAt,costMicros:760_000,reservedMicros:500_000,inputTokens:1200,outputTokens:400,cachedTokens:800,inputAudioTokens:4200,outputAudioTokens:3600,transcriptionSeconds:75}],
      rateCardVersion:'2026-10-28',
    },
  };
}

async function stubBootstrap(page:Page,payload:unknown) {
  await page.route('**/api/bootstrap*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)}));
}

async function expectUsageHidden(page:Page) {
  await expect(page.getByRole('button',{name:'费用与用量'})).toHaveCount(0);
  await expect(page.getByText('应用级支出保护')).toHaveCount(0);
  await expect(page.getByText('gpt-realtime-2.1')).toHaveCount(0);
  await expect(page.getByText(/总 token|其中音频|占用 \$0\.76/)).toHaveCount(0);
}

test('顾问桌面案例只显示四个业务标签，不展示费用账本',async({page})=>{
  await stubBootstrap(page,advisorBootstrap());
  await page.goto('/');
  const tabs=page.getByRole('navigation',{name:'案例详情'}).getByRole('button');
  await expect(tabs).toHaveCount(4);
  await expect(tabs).toHaveText(['访谈记录','画像与来源','内部报告','通知预览']);
  await expectUsageHidden(page);
});

test('390px 顾问案例不展示费用入口或 token 明细',async({page})=>{
  await stubBootstrap(page,advisorBootstrap());
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await page.getByRole('button',{name:/王芳 · 合成客户/}).click();
  await expect(page.getByRole('navigation',{name:'案例详情'}).getByRole('button')).toHaveCount(4);
  await expectUsageHidden(page);
});

test('客户受限模式即使响应含 usage 也不展示费用信息',async({page})=>{
  const payload={
    csrf:'client-csrf',mode:'client',user:null,clients:[],cases:[],
    activeCase:{id:'case-1',clientId:'',ownerAgentId:'',status:'interviewing',entry:'life',createdAt:'',updatedAt:'',assignedReviewerId:null,reportVersion:0},
    messages:[],facts:[],reports:[],notifications:[],reviews:[],clientSession:{id:'session-1',state:'active',entry:null},
    capabilities:{analysis:'mock（模拟分析）',interview:'模拟访谈',voice:'实时语音未配置',voiceConfigured:false,mail:'dry-run（未发送）'},demo:true,
    usage:advisorBootstrap().usage,
  };
  await stubBootstrap(page,payload);
  await page.goto('/');
  await expect(page.getByText('受限客户模式')).toBeVisible();
  await expectUsageHidden(page);
});
