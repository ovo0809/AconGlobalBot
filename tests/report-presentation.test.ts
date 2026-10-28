import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReportContent } from '../lib/domain';
import { presentReport } from '../lib/report-presentation';

function legacyReport(): ReportContent {
  return {
    caseId:'case-1',clientId:'client-1',version:1,snapshotId:'immutable-snapshot',reviewStatus:'draft',createdAt:'2026-10-28T00:00:00Z',ruleVersion:'demo_unapproved/1.0',provider:'mock',title:'合成报告',summary:'合成摘要',fullText:'不可变原文',
    facts:[{key:'goal',value:'原话保留 goal / source-1 / draft，不改写。',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:['source-1'],confirmedBy:null,confirmedAt:null}],
    analyses:[{category:'life',status:'priority_discussion',evidenceRefs:['source-1'],reasonSummary:'合成理由',missingFields:['existing_life'],constraints:[],nextQuestions:[]}],
    sections:[
      {title:'一、客户画像',body:'• goal: 原话保留 goal / source-1 / draft，不改写。 [客户陈述／待核验]；来源：source-1 [客户自述]'},
      {title:'二、四类初步方向',body:'合成方向'},
      {title:'三、证据与理由',body:'• 人寿：source-1'},
      {title:'四、反对因素／限制／缺失',body:'• 人寿缺失：existing_life'},
      {title:'五、下次问题',body:'合成问题'},
      {title:'六、交接',body:'• 当前复核状态：draft。'},
    ],
  };
}

test('legacy display localizes scaffolding and references without changing customer words or saved version',()=>{
  const report=legacyReport();const original=JSON.stringify(report);const view=presentReport(report);
  assert.match(view.sections[0].body,/主要目标：原话保留 goal \/ source-1 \/ draft，不改写。/);
  assert.match(view.sections[0].body,/来源：来源 1 \[客户自述\]/);
  assert.equal(view.sections[2].body,'• 人寿：来源 1');
  assert.equal(view.sections[3].body,'• 人寿缺失：现有人寿保障');
  assert.equal(view.sections[5].body,'• 当前复核状态：草稿。');
  assert.deepEqual(view.references,[{id:'source-1',label:'来源 1'}]);
  assert.equal(JSON.stringify(report),original);
});

test('no extracted facts is not displayed as a customer claim of unknown',()=>{
  const report=legacyReport();report.facts=[];
  assert.equal(presentReport(report).sections[0].body,'尚未提取到有来源的访谈事实，请先核对访谈记录。');
});

test('new report source kinds and explicit unknown survive the screen projection',()=>{
  const report=legacyReport();report.facts[0]={...report.facts[0],key:'budget',value:null,factStatus:'unknown'};
  report.sections[0].body='• 预算：客户表示不清楚；来源：source-1 [顾问更正；actor_id=advisor-1]';
  const body=presentReport(report).sections[0].body;
  assert.equal(body,'• 预算：客户表示不清楚；来源：来源 1 [顾问更正；actor_id=advisor-1]');
  assert.equal(report.facts[0].value,null);
});
