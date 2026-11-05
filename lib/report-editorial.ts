import type { AnalysisItem, Category, ProfileField, ReportContent, ReportEditorialReview, ReportWritingBrief } from './domain';
import { factLabels } from './report-labels';

const CATEGORY_FACT_KEYS: Record<Category, ReadonlySet<string>> = {
  life: new Set(['dependents', 'debt', 'existing_life']),
  annuity: new Set(['goal', 'horizon', 'assets', 'retirement', 'liquidity']),
  ltc: new Set(['care', 'existing_ltc']),
  disability_income: new Set(['employment', 'income', 'expenses', 'reserve', 'existing_di']),
};

const STATUS_PRIORITY: Record<AnalysisItem['status'], number> = {
  priority_discussion: 0,
  review_existing: 1,
  secondary_discussion: 2,
  insufficient_information: 3,
  defer: 4,
};

const CATEGORY_LABELS: Record<Category, string> = {
  life: '人寿保险',
  annuity: '年金',
  ltc: '长期护理',
  disability_income: '伤残收入保险',
};

function uniqueKeys(facts: ProfileField[], predicate: (fact: ProfileField) => boolean): string[] {
  return [...new Set(facts.filter(predicate).map((fact) => fact.key))];
}

function hasKnownValue(fact: ProfileField): boolean {
  return fact.value !== null && !(typeof fact.value === 'string' && fact.value.trim() === '');
}

export function buildReportWritingBrief(facts: ProfileField[], incompleteTranscript: boolean): ReportWritingBrief {
  return {
    audience: '归属顾问与 Charles 人工复核人员',
    purpose: '基于已保存事实形成内部复核、客户补问与后续交接依据',
    knownFactKeys: uniqueKeys(facts, (fact) =>
      (fact.factStatus === 'confirmed' || fact.factStatus === 'reported_unverified') && hasKnownValue(fact)),
    unknownFactKeys: uniqueKeys(facts, (fact) => fact.factStatus === 'unknown'),
    declinedFactKeys: uniqueKeys(facts, (fact) => fact.factStatus === 'declined'),
    conflictingFactKeys: uniqueKeys(facts, (fact) => fact.factStatus === 'conflicting'),
    incompleteTranscript,
  };
}

function normalizedQuestionKey(question: string): string {
  return question
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/(\d)[.,](?=\d)/g, '$1\uE000')
    .replace(/[\s，,。.!！?？;；:：、]+/g, '')
    .replace(/\uE000/g, '.');
}

function cleanQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ');
}

function splitQuestionClauses(candidate: string): string[] {
  const text = cleanQuestion(candidate);
  if (!text) return [];
  const clauses: string[] = [];
  const terminators = /[?？]+/g;
  let start = 0;
  for (const match of text.matchAll(terminators)) {
    const end = (match.index ?? 0) + match[0].length;
    const clause = cleanQuestion(text.slice(start, end));
    if (clause) clauses.push(clause);
    start = end;
  }
  const trailing = cleanQuestion(text.slice(start));
  if (trailing && clauses.length > 0) {
    clauses[clauses.length - 1] = `${clauses[clauses.length - 1]}${trailing}`;
  } else if (trailing) {
    clauses.push(trailing);
  }
  return clauses;
}

function analysisHasConflictingFact(analysis: AnalysisItem, conflictingKeys: Set<string>): boolean {
  const categoryKeys = CATEGORY_FACT_KEYS[analysis.category];
  if ([...conflictingKeys].some((key) => categoryKeys.has(key))) return true;
  return analysis.missingFields.some((key) => conflictingKeys.has(key))
    || analysis.evidenceRefs.some((ref) => ref.startsWith('fact:') && conflictingKeys.has(ref.slice(5)));
}

export function prioritizeReportQuestions(analyses: AnalysisItem[], facts: ProfileField[], entry: Category | null): string[] {
  const conflictingKeys = new Set(facts.filter((fact) => fact.factStatus === 'conflicting').map((fact) => fact.key));
  const ordered = analyses
    .map((item, index) => ({item, index, conflicting: analysisHasConflictingFact(item, conflictingKeys)}))
    .sort((left, right) =>
      Number(right.conflicting) - Number(left.conflicting)
      || Number(right.item.category === entry) - Number(left.item.category === entry)
      || STATUS_PRIORITY[left.item.status] - STATUS_PRIORITY[right.item.status]
      || left.index - right.index);

  const seen = new Set<string>();
  const questions: string[] = [];
  for (const {item} of ordered) {
    for (const original of item.nextQuestions) {
      for (const question of splitQuestionClauses(original)) {
        const key = normalizedQuestionKey(question);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        questions.push(question);
      }
    }
  }
  return questions;
}

type EditorialReport = Pick<ReportContent, 'caseId' | 'snapshotId' | 'sections' | 'facts' | 'analyses' | 'sourceReferences' | 'reviewStatus'>;
type EditorialIssue = ReportEditorialReview['issues'][number];

function cloneBrief(brief: ReportWritingBrief): ReportWritingBrief {
  return {
    audience: brief.audience,
    purpose: brief.purpose,
    knownFactKeys: [...brief.knownFactKeys],
    unknownFactKeys: [...brief.unknownFactKeys],
    declinedFactKeys: [...brief.declinedFactKeys],
    conflictingFactKeys: [...brief.conflictingFactKeys],
    incompleteTranscript: brief.incompleteTranscript,
  };
}

function visibleQuestions(report: EditorialReport): string[] {
  const section = report.sections.find((item) => item.title.includes('问题')) ?? report.sections[4];
  if (!section) return [];
  const noneQuestionKeys = new Set(['无', '暂无', '没有', '无需补问', '无待补问', '暂无问题']);
  return section.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[•●▪*-]|\d+[.)、])\s*/.test(line))
    .map((line) => line.replace(/^(?:[•●▪*-]|\d+[.)、])\s*/, '').trim())
    .flatMap(splitQuestionClauses)
    .filter((question) => {
      const key = normalizedQuestionKey(question);
      return Boolean(key) && !noneQuestionKeys.has(key);
    });
}

function containsDisplayArtifact(text: string): boolean {
  return /\uFFFD|\[object Object\]|\bundefined\b|\bNaN\b|\bTODO\b|待填写|待补正文|to be written/i.test(text);
}

function containsTechnicalIdentifier(text: string, report: EditorialReport): boolean {
  if (/\b(?:case_id|client_id|snapshot_id|actor_id|sourceMessageIds|evidenceRefs|knowledgeRefs|report_version)\b/i.test(text)) return true;
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text)) return true;
  const identifiers = [report.caseId, report.snapshotId, ...(report.sourceReferences ?? []).map((item) => item.id)]
    .filter((id) => id.length >= 2);
  return identifiers.some((id) => text.includes(id));
}

function statusForGoal(facts: ProfileField[]): {answer: string; status: 'located' | 'needs_attention'} {
  const goal = facts.find((fact) => fact.key === 'goal');
  if (!goal) return {answer: '尚未形成有来源的主要目标记录，需要由顾问补充或确认。', status: 'needs_attention'};
  if (goal.factStatus === 'unknown') return {answer: '主要目标已按“客户表示不清楚”保留，未替客户补写答案。', status: 'located'};
  if (goal.factStatus === 'declined') return {answer: '主要目标已按“客户不愿提供”保留，未替客户补写答案。', status: 'located'};
  if (goal.factStatus === 'conflicting') return {answer: '主要目标存在冲突，报告已保留为待核对状态。', status: 'located'};
  if (hasKnownValue(goal)) return {answer: '报告已定位有来源的主要目标记录，具体内容仍须结合来源人工核对。', status: 'located'};
  return {answer: '主要目标记录没有可用内容，需要由顾问补充或确认。', status: 'needs_attention'};
}

export function reviewReportDraft(report: EditorialReport, brief: ReportWritingBrief): ReportEditorialReview {
  const issues: EditorialIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (issue: EditorialIssue) => {
    const key = `${issue.code}|${issue.section ?? ''}|${issue.message}`;
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(issue);
    }
  };

  if (report.sections.length !== 6) {
    addIssue({code: 'section_count', message: '内部报告应包含六个完整部分。'});
  }
  report.sections.forEach((section, index) => {
    const sectionName = `第 ${index + 1} 部分`;
    if (!section.title.trim() || !section.body.trim()) {
      addIssue({code: 'empty_section', section: sectionName, message: `${sectionName}缺少标题或正文。`});
    }
    const text = `${section.title}\n${section.body}`;
    if (containsDisplayArtifact(text)) {
      addIssue({code: 'display_artifact', section: sectionName, message: `${sectionName}含有占位文字或异常显示内容。`});
    }
    if (containsTechnicalIdentifier(text, report)) {
      addIssue({code: 'technical_identifier', section: sectionName, message: `${sectionName}暴露了面向系统的技术标识，应改为可读来源标签。`});
    }
  });

  const knownKeys = new Set(brief.knownFactKeys);
  for (const item of report.analyses) {
    for (const missing of item.missingFields) {
      if (knownKeys.has(missing)) {
        const safeLabel = factLabels[missing] ?? '某项事实';
        const categoryLabel = CATEGORY_LABELS[item.category];
        addIssue({
          code: 'known_fact_marked_missing',
          section: categoryLabel,
          message: `${categoryLabel}分析中的“${safeLabel}”已有事实记录，却仍列为缺失，需要人工核对。`,
        });
      }
    }
  }

  const questions = visibleQuestions(report);
  const questionKeys = questions.map(normalizedQuestionKey).filter(Boolean);
  if (new Set(questionKeys).size !== questionKeys.length) {
    addIssue({code: 'duplicate_question', section: '下次问题', message: '下次问题中有重复内容，需要合并。'});
  }
  if (questions.length > 3) {
    addIssue({code: 'too_many_questions', section: '下次问题', message: '可见的下次问题超过三项，需要优先保留最关键的问题。'});
  }

  const sources = new Map((report.sourceReferences ?? []).map((item) => [item.id, item]));
  const validateSource = (sourceId: string) => {
    const source = sources.get(sourceId);
    if (!source) {
      addIssue({code: 'missing_source_reference', message: '报告引用的客户事实缺少可核对的来源记录。'});
      return;
    }
    if (source.caseId !== report.caseId) {
      addIssue({code: 'cross_case_source_reference', message: '报告包含来自其他案例的来源记录，必须移除并重新核对。'});
    }
    if (!source.final) {
      addIssue({code: 'non_final_source_reference', message: '报告引用了尚未最终确认的转写记录。'});
    }
    if (source.role !== 'user') {
      addIssue({code: 'non_customer_source_reference', message: '报告引用了 AI 助手消息作为客户事实来源，需要改用客户或顾问确认的记录。'});
    }
  };
  report.facts.forEach((item) => {
    if (item.sourceMessageIds.length === 0
      && hasKnownValue(item)
      && (item.factStatus === 'reported_unverified' || (item.factStatus === 'confirmed' && !item.confirmedBy))) {
      addIssue({code: 'missing_source_reference', message: '报告中的一项已知事实缺少可核对的来源记录。'});
    }
    item.sourceMessageIds.forEach(validateSource);
  });

  const factsByKey = new Map(report.facts.map((item) => [item.key, item]));
  for (const item of report.analyses) {
    for (const evidence of item.evidenceRefs) {
      if (evidence.startsWith('fact:')) {
        const referencedFact = factsByKey.get(evidence.slice(5));
        if (!referencedFact || referencedFact.factStatus !== 'confirmed') {
          addIssue({code: 'invalid_manual_fact_reference', message: '人工事实引用不是已确认状态，需要改用原始来源或完成确认。'});
        }
      } else {
        validateSource(evidence);
      }
    }
  }

  if (brief.incompleteTranscript) {
    addIssue({code: 'incomplete_transcript', message: '本次访谈记录不完整，人工复核时必须确认缺失范围。'});
  }

  const goalCheck = statusForGoal(report.facts);
  if (goalCheck.status === 'needs_attention') {
    addIssue({code: 'missing_goal_context', message: '报告尚未定位客户主要目标，需要补充或确认。'});
  }
  const knownCount = brief.knownFactKeys.length;
  const unresolvedCount = brief.unknownFactKeys.length + brief.declinedFactKeys.length + brief.conflictingFactKeys.length;
  const sourceIssueCodes = new Set([
    'missing_source_reference', 'cross_case_source_reference', 'non_final_source_reference',
    'non_customer_source_reference', 'invalid_manual_fact_reference',
  ]);
  const hasSourceIssue = issues.some((item) => sourceIssueCodes.has(item.code));
  const limitSection = report.sections.find((item) => /限制|缺失|反对/.test(item.title));
  const nextSection = report.sections.find((item) => /问题|下一步/.test(item.title));
  const reviewSection = report.sections.find((item) => /复核|审核|Charles/.test(item.title));

  const checks: ReportEditorialReview['checks'] = [
    {id: 'goal', question: '读者能否定位客户主要目标及其当前事实状态？', answer: goalCheck.answer, status: goalCheck.status},
    {
      id: 'evidence', question: '读者能否确认结论基于已保存事实和可核对来源？',
      answer: hasSourceIssue
        ? `报告记录了 ${knownCount} 项有内容的已知事实，但来源检查发现问题，需要人工处理后再核对事实含义。`
        : `报告记录了 ${knownCount} 项有内容的已知事实；来源完整性已通过本地规则检查，但仍需人工核对事实含义。`,
      status: hasSourceIssue ? 'needs_attention' : 'located',
    },
    {
      id: 'unresolved', question: '读者能否找到未知、拒答、冲突和其他限制？',
      answer: limitSection
        ? `限制部分已定位；另有 ${unresolvedCount} 项未知、拒答或冲突状态需要按原状态保留。`
        : `尚未定位限制部分；当前有 ${unresolvedCount} 项未知、拒答或冲突状态。`,
      status: limitSection ? 'located' : 'needs_attention',
    },
    {
      id: 'next_action', question: '读者能否看出下一步需要确认什么？',
      answer: nextSection ? `下一步部分已定位，当前显示 ${questions.length} 个优先问题。` : '尚未定位下一步问题或行动部分。',
      status: nextSection ? 'located' : 'needs_attention',
    },
    {
      id: 'business_review', question: '读者是否明确本报告仍须经过业务人工复核？',
      answer: reviewSection
        ? '报告已标明顾问与 Charles 的人工复核环节；本地规则检查不证明业务语义准确。'
        : '尚未定位人工复核说明；本地规则检查不证明业务语义准确。',
      status: reviewSection ? 'located' : 'needs_attention',
    },
  ];

  for (const check of checks) {
    if (check.status === 'needs_attention' && check.id !== 'goal') {
      addIssue({code: `reader_${check.id}`, message: '报告缺少读者完成复核所需的明确指引。'});
    }
  }

  return {
    version: 'doc-coauthoring/1',
    method: 'local_rules',
    status: issues.length === 0 && checks.every((item) => item.status === 'located')
      ? 'ready_for_human_review'
      : 'needs_attention',
    brief: cloneBrief(brief),
    checks,
    issues,
  };
}
