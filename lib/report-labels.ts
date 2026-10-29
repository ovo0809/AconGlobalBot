import type { DemandStatus, FactStatus, ProfileField } from './domain';

export const factLabels: Record<string, string> = {
  goal: '主要目标',
  horizon: '目标时间',
  dependents: '家庭责任',
  state: '居住州',
  employment: '工作情况',
  income: '收入',
  expenses: '家庭开支',
  debt: '债务',
  reserve: '应急储备',
  assets: '资产与资金',
  existing_life: '现有人寿保障',
  existing_di: '现有伤残保障',
  existing_ltc: '现有照护安排',
  budget: '预算',
  liquidity: '流动性偏好',
  retirement: '退休计划',
  care: '照护考虑',
};

export const demandStatusLabels: Record<DemandStatus, string> = {
  priority_discussion: '优先讨论',
  secondary_discussion: '次要讨论',
  defer: '暂缓',
  insufficient_information: '资料不足',
  review_existing: '复核现有安排',
};

export const reviewStatusLabels: Record<string, string> = {
  draft: '草稿',
  pending_review: '待复核',
  approved: '已复核',
  returned: '退回补问',
  quote_handoff: '已转现有报价流程',
};

export const factStatusLabels: Record<FactStatus, string> = {
  confirmed: '已确认',
  reported_unverified: '客户自述／待核验',
  unknown: '客户表示不清楚',
  declined: '客户不愿提供',
  conflicting: '存在冲突',
};

const periodLabels: Record<string, string> = {
  month: '每月',
  year: '每年',
  once: '一次性／余额',
};

export function factLabel(key: string): string {
  return factLabels[key] ?? key;
}

export function reviewStatusLabel(status: string): string {
  return reviewStatusLabels[status] ?? status;
}

export function formatFactValue(fact: ProfileField): string {
  if (fact.factStatus === 'unknown') return '客户表示不清楚';
  if (fact.factStatus === 'declined') return '客户不愿提供';
  if (fact.factStatus === 'conflicting' && fact.value === null) return '说法存在冲突，待核对';
  if (fact.value === null) return '未提供';

  const value = fact.value;
  if (!fact.currency && !fact.period) return String(value);
  const unit = [fact.currency, fact.period ? periodLabels[fact.period] ?? fact.period : null].filter(Boolean).join('／');
  return `${String(value)}（${unit}）`;
}
