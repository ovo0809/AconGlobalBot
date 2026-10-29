import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { messageSource, type AnalysisItem, type Category, type DemandStatus, type Message, type ProfileField, type ReportContent, type ReportInput } from './domain';
import { demandStatusLabels, factLabel, factStatusLabels, formatFactValue, reviewStatusLabel } from './report-labels';

const CATEGORIES: Category[] = ['life', 'annuity', 'ltc', 'disability_income'];
const STATUSES: DemandStatus[] = ['priority_discussion', 'secondary_discussion', 'defer', 'insufficient_information', 'review_existing'];
const MONEY_KEYS = new Set(['income', 'expenses', 'debt', 'reserve', 'assets', 'budget']);
const PERIODS = new Set(['month', 'year', 'once']);
const RULE_VERSION = 'demo_unapproved/1.0';
const FONT_PATH = path.join(process.cwd(), 'public', 'fonts', 'NotoSansCJKsc-Regular.otf');

const categoryLabel: Record<Category, string> = { life: '人寿', annuity: '年金／退休收入', ltc: '长期护理', disability_income: '伤残收入保障' };

const factMap = (facts: ProfileField[]) => new Map(facts.map((fact) => [fact.key, fact]));
const usable = (fact: ProfileField | undefined): fact is ProfileField => Boolean(fact && (fact.factStatus === 'confirmed' || fact.factStatus === 'reported_unverified') && fact.value !== null && fact.value !== '');

function evidence(facts: ProfileField[]): string[] {
  const messageRefs = facts.flatMap((fact) => fact.sourceMessageIds);
  if (messageRefs.length) return [...new Set(messageRefs)];
  return facts.filter((fact) => fact.factStatus === 'confirmed').map((fact) => `fact:${fact.key}`);
}

function analysis(category: Category, status: DemandStatus, supporting: ProfileField[], reasonSummary: string, missingFields: string[], constraints: string[], nextQuestions: string[]): AnalysisItem {
  return { category, status, evidenceRefs: evidence(supporting), reasonSummary, missingFields, constraints, nextQuestions };
}

const conflicting = (facts: ProfileField[], keys: string[]) => facts.filter((fact) => keys.includes(fact.key) && fact.factStatus === 'conflicting');

function specialReview(facts: ProfileField[]): string[] {
  const text = facts.map((fact) => typeof fact.value === 'string' ? fact.value : '').join(' ');
  return /(rollover|转保|退保|资金转移|账户转移)/i.test(text)
    ? ['涉及账户转移、转保或退保表达，必须由 Charles 专项人工审核；本报告不提供执行指令。']
    : [];
}

/** Demo-only topic ordering. It never selects products, prices or underwriting outcomes. */
export function analyzeDemo(facts: ProfileField[]): AnalysisItem[] {
  validateFacts(facts);
  const map = factMap(facts);
  const special = specialReview(facts);

  const dependents = map.get('dependents');
  const debt = map.get('debt');
  const existingLife = map.get('existing_life');
  const lifeConflicts = conflicting(facts, ['dependents', 'debt', 'existing_life']);
  const lifeSupport = [dependents, debt, existingLife].filter(usable);
  const life = lifeConflicts.length
    ? analysis('life', 'insufficient_information', lifeConflicts, '家庭责任或现有保障信息存在冲突，暂不能形成讨论优先级。', [], ['必须先澄清冲突，不得以任一说法覆盖另一说法。'], ['请核对家庭责任、债务和现有保障。'])
    : usable(existingLife)
      ? analysis('life', 'review_existing', lifeSupport, '已陈述存在人寿保障，应先由顾问核对范围、期限与家庭责任。', [], ['现有保障未经核验，不表示充足或不足。'], ['现有保障的类型、期限、金额及受益安排是什么？'])
      : usable(dependents) || usable(debt)
        ? analysis('life', 'priority_discussion', lifeSupport, '存在家庭责任或债务线索，适合优先核实身故后的责任与现有保障。', ['existing_life'], ['仅为讨论顺序，不构成产品建议或承保结论。'], ['目前已有何种人寿保障？希望覆盖哪些责任与时间范围？'])
        : analysis('life', 'insufficient_information', [], '缺少家庭责任、债务与现有保障资料。', ['dependents', 'debt', 'existing_life'], ['资料不足时不得推断“无需新增”。'], ['是否有受扶养人、重要债务或现有人寿保障？']);

  const goal = map.get('goal');
  const horizon = map.get('horizon');
  const assets = map.get('assets');
  const retirement = map.get('retirement');
  const liquidity = map.get('liquidity');
  const annuityConflicts = conflicting(facts, ['goal', 'horizon', 'assets', 'retirement', 'liquidity']);
  const annuitySupport = [goal, horizon, assets, retirement, liquidity].filter(usable);
  const retirementGoal = usable(goal) && /(退休|现金流|retir)/i.test(String(goal.value));
  const annuity = annuityConflicts.length
    ? analysis('annuity', 'insufficient_information', annuityConflicts, '退休目标、金额或流动性信息存在冲突。', [], ['不得把冲突金额用于计算。', ...special], ['请确认退休时间、资金口径和流动性要求。'])
    : retirementGoal
      ? analysis('annuity', usable(horizon) && usable(liquidity) ? 'priority_discussion' : 'secondary_discussion', annuitySupport, '客户表达退休或未来现金流目标，可继续核实时间、资金用途与流动性约束。', [!usable(horizon) ? 'horizon' : '', !usable(liquidity) ? 'liquidity' : '', !usable(retirement) ? 'retirement' : ''].filter(Boolean), ['入口不等于产品推荐；需由人工比较流动性、费用、税务及替代方案。', ...special], ['预计何时使用资金？希望保留多少流动性？退休需求是什么？'])
      : usable(assets) || usable(retirement)
        ? analysis('annuity', 'secondary_discussion', annuitySupport, '存在资产或退休线索，但目标和约束尚未完整。', ['goal', 'horizon', 'liquidity'], ['不得仅因存在资产就固定映射为年金。', ...special], ['这笔资金的目标、使用时间和流动性要求是什么？'])
        : analysis('annuity', 'insufficient_information', [], '缺少退休目标、时间与流动性资料。', ['goal', 'horizon', 'retirement', 'liquidity'], ['资料不足，不形成产品方向。', ...special], ['是否有退休时间、收入需求或流动性目标？']);

  const care = map.get('care');
  const existingLtc = map.get('existing_ltc');
  const ltcConflicts = conflicting(facts, ['care', 'existing_ltc']);
  const ltcSupport = [care, existingLtc].filter(usable);
  const ltc = ltcConflicts.length
    ? analysis('ltc', 'insufficient_information', ltcConflicts, '照护目标或现有安排存在冲突。', [], ['必须澄清冲突，不把“生前福利”自动等同于长期护理。'], ['请核对现有照护安排与偏好。'])
    : usable(existingLtc)
      ? analysis('ltc', 'review_existing', ltcSupport, '已陈述存在照护安排，应先复核范围、限制与目标。', [], ['不根据名称推断具体给付或适用性。'], ['现有安排包括哪些照护情形、等待期与限制？'])
      : usable(care)
        ? analysis('ltc', 'priority_discussion', ltcSupport, '存在照护担忧或偏好，可继续厘清目标与资源。', ['existing_ltc'], ['仅澄清担忧，不承诺具体给付或条款。'], ['希望在哪里接受照护？目前有哪些照护资源或保障？'])
        : analysis('ltc', 'insufficient_information', [], '缺少照护目标与现有安排资料。', ['care', 'existing_ltc'], ['资料不足，不推断照护需求。'], ['是否有长期照护担忧、偏好或现有安排？']);

  const employment = map.get('employment');
  const income = map.get('income');
  const existingDi = map.get('existing_di');
  const reserve = map.get('reserve');
  const diConflicts = conflicting(facts, ['employment', 'income', 'existing_di', 'reserve']);
  const diSupport = [employment, income, existingDi, reserve].filter(usable);
  const existingDiPresent = usable(existingDi) && !/(没有|无|未配置|不确定)/i.test(String(existingDi.value));
  const disability = diConflicts.length
    ? analysis('disability_income', 'insufficient_information', diConflicts, '收入、职业或现有保障资料存在冲突。', [], ['必须先确认金额币种及月／年周期。'], ['请确认职业、收入周期与现有伤残收入保障。'])
    : existingDiPresent
      ? analysis('disability_income', 'review_existing', diSupport, '已陈述存在伤残收入保障，应先复核给付定义、期限与收入依赖。', [], ['现有保障未经核验，不表示充足或适合。'], ['现有保障的给付定义、金额、等待期与期限是什么？'])
      : usable(employment) || usable(income)
        ? analysis('disability_income', usable(employment) && usable(income) ? 'priority_discussion' : 'secondary_discussion', diSupport, '存在劳动收入依赖线索，可继续核实现有保障和收入中断承受能力。', ['existing_di', !usable(reserve) ? 'reserve' : ''].filter(Boolean), ['不根据职业、年龄或性别直接决定适合性。'], ['若收入中断，现有保障与储备可覆盖多久？'])
        : analysis('disability_income', 'insufficient_information', [], '缺少职业、收入依赖与现有保障资料。', ['employment', 'income', 'existing_di'], ['资料不足，不推断收入保障缺口。'], ['目前是否依赖劳动收入？是否已有伤残收入保障？']);

  return [life, annuity, ltc, disability];
}

export function validateFacts(facts: ProfileField[]): void {
  const keys = new Set<string>();
  for (const fact of facts) {
    if (!fact.key || keys.has(fact.key)) throw new Error(`事实字段重复或为空: ${fact.key || '(empty)'}`);
    keys.add(fact.key);
    if (!['confirmed', 'reported_unverified', 'unknown', 'declined', 'conflicting'].includes(fact.factStatus)) throw new Error(`无效事实状态: ${fact.factStatus}`);
    if ((fact.factStatus === 'unknown' || fact.factStatus === 'declined') && fact.value !== null) throw new Error(`${fact.key}: 未知／拒答必须保留为 null`);
    if ((fact.factStatus === 'confirmed' || fact.factStatus === 'reported_unverified') && (fact.value === null || fact.value === '')) throw new Error(`${fact.key}: 已确认／客户陈述需要非空值`);
    if (typeof fact.value === 'number' && (!Number.isFinite(fact.value) || fact.value < 0)) throw new Error(`${fact.key}: 数值必须为有限非负数`);
    if (MONEY_KEYS.has(fact.key) && typeof fact.value === 'number' && (!fact.currency || !fact.period || !PERIODS.has(fact.period))) throw new Error(`${fact.key}: 金额必须含币种及 month/year/once 周期`);
    if (!Array.isArray(fact.sourceMessageIds) || new Set(fact.sourceMessageIds).size !== fact.sourceMessageIds.length) throw new Error(`${fact.key}: 来源消息引用无效或重复`);
  }
}

export function validateAnalyses(analyses: AnalysisItem[], facts: ProfileField[], messages: Message[]): void {
  validateFacts(facts);
  if (analyses.length !== 4) throw new Error('分析必须恰好包含四个类别');
  const categories = new Set(analyses.map((entry) => entry.category));
  if (categories.size !== 4 || CATEGORIES.some((category) => !categories.has(category))) throw new Error('四个分析类别必须完整且不重复');
  const factsByKey = factMap(facts);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  if (new Set(messages.map((message) => message.caseId)).size > 1) throw new Error('不能混用不同案例的消息');
  for (const entry of analyses) {
    if (!STATUSES.includes(entry.status)) throw new Error(`${entry.category}: 无效需求状态`);
    if (!entry.reasonSummary.trim()) throw new Error(`${entry.category}: 缺少理由摘要`);
    for (const key of ['evidenceRefs', 'missingFields', 'constraints', 'nextQuestions'] as const) if (!Array.isArray(entry[key])) throw new Error(`${entry.category}: ${key} 必须为数组`);
    for (const ref of entry.evidenceRefs) {
      if (ref.startsWith('fact:')) {
        const sourceFact = factsByKey.get(ref.slice(5));
        if (!sourceFact || sourceFact.factStatus !== 'confirmed') throw new Error(`${entry.category}: 确认字段引用无效: ${ref}`);
      } else {
        const message = messagesById.get(ref);
        if (!message || !message.final) throw new Error(`${entry.category}: 消息证据不存在或不是最终转写: ${ref}`);
      }
    }
    if (!entry.evidenceRefs.length && entry.status !== 'insufficient_information') throw new Error(`${entry.category}: 非资料不足结论必须有案例内证据`);
  }
  for (const fact of facts) for (const ref of fact.sourceMessageIds) {
    const source = messagesById.get(ref);
    if (!source || !source.final) throw new Error(`${fact.key}: 来源消息不存在或不是最终转写: ${ref}`);
  }
}

const sourceKindLabel = { customer: '客户自述', advisor: '顾问更正', synthetic: '合成资料' } as const;

function factSourceSummary(fact: ProfileField, messagesById: Map<string, Message>): string {
  if (!fact.sourceMessageIds.length) {
    return fact.confirmedBy ? `无消息来源 ID；人工确认 actor_id=${fact.confirmedBy}` : '无消息来源 ID';
  }
  return fact.sourceMessageIds.map((id) => {
    const message = messagesById.get(id)!;
    const actor = message.actorId ? `；actor_id=${message.actorId}` : '';
    const recording=message.sourceKind==='advisor_reviewed_recording';
    const kind=recording?'顾问核对的录音客户发言':sourceKindLabel[messageSource(message)];
    const segments=recording&&message.recordingSegmentIds?.length?`；录音片段=${message.recordingSegmentIds.join(',')}`:'';
    return `${id} [${kind}${actor}${segments}]`;
  }).join('、');
}

const bullets = (lines: string[]) => lines.length ? lines.map((line) => `• ${line}`).join('\n') : '• 无';

export function buildReport(input: ReportInput): ReportContent {
  validateAnalyses(input.analyses, input.facts, input.messages);
  if (input.messages.some((message) => message.caseId !== input.caseRecord.id)) throw new Error('报告消息不属于当前案例');
  if (input.caseRecord.clientId !== input.client.id) throw new Error('报告客户与案例关联不一致');
  if (input.caseRecord.ownerAgentId !== input.owner.id) throw new Error('报告归属顾问与案例不一致');

  const messagesById = new Map(input.messages.map((message) => [message.id, message]));
  const factLines = input.facts.map((fact) => {
    const value = formatFactValue(fact);
    const status = factStatusLabels[fact.factStatus];
    return `${factLabel(fact.key)}：${value}${value === status ? '' : ` [${status}]`}；来源：${factSourceSummary(fact, messagesById)}`;
  });
  const directionLines = input.analyses.map((entry) => `${categoryLabel[entry.category]} — ${demandStatusLabels[entry.status]}：${entry.reasonSummary}`);
  const evidenceLines = input.analyses.map((entry) => `${categoryLabel[entry.category]}：${entry.evidenceRefs.length ? entry.evidenceRefs.join('、') : '无引用；资料不足'}`);
  const limitationLines = input.analyses.flatMap((entry) => entry.constraints.map((constraint) => `${categoryLabel[entry.category]}：${constraint}`));
  const missingCategories = new Map<string, Set<Category>>();
  for (const entry of input.analyses) for (const field of entry.missingFields) {
    const categories = missingCategories.get(field) ?? new Set<Category>();
    categories.add(entry.category);
    missingCategories.set(field, categories);
  }
  limitationLines.push(...[...missingCategories].map(([field, categories]) =>
    `待补充：${factLabel(field)}（涉及：${[...categories].map((category) => categoryLabel[category]).join('、')}）`,
  ));
  if (input.incompleteTranscript) limitationLines.unshift('部分语音转写未完成或收尾超时；未确认的残留片段未作为事实，需顾问核对。');
  const questionLines = [...new Set(input.analyses.flatMap((entry) => entry.nextQuestions))];
  const specialLines = limitationLines.filter((line) => /(专项|转移|转保|退保|冲突)/.test(line));
  const reviewNote = input.reviewNote?.trim();
  const sections = [
    { title: '一、客户画像', body: factLines.length ? bullets(factLines) : '尚未提取到有来源的访谈事实，请先核对访谈记录。' },
    { title: '二、四类初步方向', body: bullets(directionLines) },
    { title: '三、证据与理由', body: bullets(evidenceLines) },
    { title: '四、反对因素／限制／缺失', body: bullets(limitationLines) },
    { title: '五、下次问题', body: bullets(questionLines) },
    {
      title: '六、给 Charles 的交接摘要与专项审核项',
      body: bullets([
        `请复核四类方向、证据及缺失项；当前复核状态：${reviewStatusLabel(input.reviewStatus)}。`,
        ...(reviewNote ? [`本版本人工复核意见：${reviewNote}`] : []),
        ...(specialLines.length ? specialLines : ['未识别到专项执行事项；所有业务判断仍需人工审核。']),
        '本报告不生成报价，不执行申请、退保、转保、rollover 或资金转移。',
      ]),
    },
  ];
  const headerLines = [
    `客户显示名：${input.client.name}`,
    `client_id：${input.client.id}`,
    `case_id：${input.caseRecord.id}`,
    `归属顾问：${input.owner.name} / ${input.owner.id}`,
    `顾问联系邮箱（程序字段）：${input.owner.email}`,
    `生成时间：${input.createdAt}`,
    `report_version：${input.version}`,
    `复核状态：${reviewStatusLabel(input.reviewStatus)}`,
    `snapshot_id：${input.snapshotId}`,
    `规则版本：${RULE_VERSION}`,
    `分析来源：${input.provider}`,
  ];
  const header = headerLines.join('\n');
  const disclaimer = '演示规则，待业务审核。本报告为内部初筛与人工交接材料，不是产品推荐、报价、核保、法律或税务意见。';
  const fullText = ['Aeconn AI Agent 内部报告', header, disclaimer, ...sections.map((section) => `${section.title}\n${section.body}`)].join('\n\n');
  const content = {
    caseId: input.caseRecord.id,
    clientId: input.client.id,
    version: input.version,
    snapshotId: input.snapshotId,
    reviewStatus: input.reviewStatus,
    createdAt: input.createdAt,
    ruleVersion: RULE_VERSION,
    provider: input.provider,
    title: `Aeconn 内部初筛报告 — ${input.client.name}`,
    summary: `${input.client.name} 的四类需求初筛已生成，须由归属顾问与 Charles 人工复核。`,
    sections,
    fullText,
    analyses: input.analyses.map((entry) => ({ ...entry, evidenceRefs: [...entry.evidenceRefs], missingFields: [...entry.missingFields], constraints: [...entry.constraints], nextQuestions: [...entry.nextQuestions] })),
    facts: input.facts.map((fact) => ({ ...fact, sourceMessageIds: [...fact.sourceMessageIds] })),
  };
  return { ...content, headerLines };
}

export async function renderPdf(report: ReportContent): Promise<Buffer> {
  if (!fs.existsSync(FONT_PATH)) throw new Error(`缺少中文字体: ${FONT_PATH}`);
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 62, bottom: 80, left: 54, right: 54 },
      bufferPages: true,
      info: { Title: report.title, Author: 'Aeconn AI Agent Demo', Subject: `Case ${report.caseId}, report v${report.version}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.registerFont('NotoSC', FONT_PATH).font('NotoSC');

    doc.rect(0, 0, doc.page.width, 16).fill('#0F766E');
    doc.fillColor('#12343B').fontSize(21).text(report.title);
    doc.moveDown(0.35);
    doc.fillColor('#4B6570').fontSize(9.5).text(`Case ${report.caseId}  ·  Client ${report.clientId}  ·  Version ${report.version}`);
    doc.moveDown(0.55);
    const boxY = doc.y;
    doc.roundedRect(54, boxY, doc.page.width - 108, 58, 8).fill('#E8F5F2');
    doc.fillColor('#134E4A').fontSize(10).text('演示规则，待业务审核。本材料仅供归属顾问与 Charles 内部复核，不构成产品推荐、报价、核保、法律或税务意见。', 66, boxY + 11, { width: doc.page.width - 132, lineGap: 3 });
    doc.y = boxY + 70;
  const headerLines = report.headerLines ?? [
      `client_id：${report.clientId}`,
      `case_id：${report.caseId}`,
      `生成时间：${report.createdAt}`,
      `report_version：${report.version}`,
      `复核状态：${reviewStatusLabel(report.reviewStatus)}`,
      `snapshot_id：${report.snapshotId}`,
      `规则版本：${report.ruleVersion}`,
      `分析来源：${report.provider}`,
    ];
    for (const line of headerLines) {
      doc.fillColor('#324D55').fontSize(8.8).text(line, { lineGap: 1.5 });
    }
    doc.moveDown(0.7);

    for (const section of report.sections) {
      const width=doc.page.width-108;
      const headingHeight=doc.fontSize(14).heightOfString(section.title,{width,lineGap:2});
      const bodyHeight=doc.fontSize(10.2).heightOfString(section.body,{width,lineGap:5,paragraphGap:4});
      const sectionHeight=headingHeight+bodyHeight+30;
      const usableHeight=doc.page.height-doc.page.margins.top-doc.page.margins.bottom;
      if (doc.y > doc.page.height - 180 || sectionHeight<=usableHeight&&doc.y+sectionHeight>doc.page.height-doc.page.margins.bottom) doc.addPage();
      doc.fillColor('#0F766E').fontSize(14).text(section.title,54,doc.y,{width,lineGap:2});
      const lineY = doc.y + 3;
      doc.moveTo(54, lineY).lineTo(doc.page.width - 54, lineY).lineWidth(0.7).strokeColor('#B7DCD6').stroke();
      doc.moveDown(0.65);
      doc.fillColor('#20383E').fontSize(10.2).text(section.body,54,doc.y,{width,lineGap:5,paragraphGap:4});
      doc.moveDown(0.85);
    }

    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page += 1) {
      doc.switchToPage(page);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fillColor('#718188').fontSize(8).text(`Aeconn AI Agent Demo · 内部资料 · 第 ${page + 1} / ${range.count} 页`, 54, doc.page.height - 38, { width: doc.page.width - 108, align: 'center', lineBreak: false });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}
