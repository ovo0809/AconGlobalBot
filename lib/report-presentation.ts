import type { ReportContent } from './domain';
import type { KnowledgeSource } from './knowledge';
import { safeKnowledgeUrl } from './knowledge-public';
import { factLabels, factStatusLabels, formatFactValue, reviewStatusLabels } from './report-labels';

/** A read-only screen view; the saved report, PDF and email version stay immutable. */
export function presentReport(report: ReportContent) {
  const ids = [...new Set([
    ...report.facts.flatMap(fact => fact.sourceMessageIds),
    ...report.analyses.flatMap(item => item.evidenceRefs),
  ])];
  const references = ids.map((id, index) => ({ id, label: `来源 ${index + 1}` }));
  const labels = new Map(references.map(ref => [ref.id, ref.label]));
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = ids.length ? new RegExp(`(?<![\\w-])(?:${[...ids].sort((a,b)=>b.length-a.length).map(escape).join('|')})(?![\\w-])`, 'g') : null;
  const sourceText = (text: string) => pattern ? text.replace(pattern, id => labels.get(id)!) : text;
  const sections = report.sections.map((section, index) => {
    let body = section.body;
    if (index === 0) {
      // Format only generated field/status/source scaffolding, never client wording.
      body = report.facts.length ? report.facts.map(fact => {
        const originalLine = section.body.split('\n').find(line => line.startsWith(`• ${fact.key}:`) || line.startsWith(`• ${factLabels[fact.key] || fact.key}：`));
        const sourceOffset = originalLine?.lastIndexOf('；来源：') ?? -1;
        const originalSource = sourceOffset >= 0 ? originalLine!.slice(sourceOffset + 4) : fact.sourceMessageIds.join('、');
        const status = factStatusLabels[fact.factStatus];
        const value = formatFactValue(fact);
        return `• ${factLabels[fact.key] || fact.key}：${value}${value === status ? '' : ` [${status}]`}；来源：${sourceText(originalSource) || '无消息来源'}`;
      }).join('\n') : '尚未提取到有来源的访谈事实，请先核对访谈记录。';
    } else if (index === 2) {
      body = sourceText(body);
    } else if (index === 3) {
      body = body.split('\n').map(line => line.replace(/(缺失：)([^\n]+)$/, (_, prefix: string, key: string) => `${prefix}${factLabels[key] || key}`)).join('\n');
    } else if (index === 5) {
      body = body.replace(`当前复核状态：${report.reviewStatus}。`, `当前复核状态：${reviewStatusLabels[report.reviewStatus] || report.reviewStatus}。`);
    }
    return { ...section, body };
  });
  const knowledgeSources = presentKnowledgeSources(report.knowledge?.sources ?? [], report.analyses);
  return { sections, references, knowledgeSources };
}

export function presentKnowledgeSources(sources: KnowledgeSource[], analyses: ReportContent['analyses'] = []) {
  return sources.map((source) => ({
    ...source,
    safeUrl: safeKnowledgeUrl(source),
    lineLabel: source.startLine === source.endLine ? `第 ${source.startLine} 行` : `第 ${source.startLine}–${source.endLine} 行`,
    citedBy: analyses.filter((item) => item.knowledgeRefs?.includes(source.id)).map((item) => item.category),
  }));
}
