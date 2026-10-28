import type { UsageSummary } from './ai-usage';

export type Role = 'advisor' | 'reviewer' | 'admin';
export type Category = 'life' | 'annuity' | 'ltc' | 'disability_income';
export type FactStatus = 'confirmed' | 'reported_unverified' | 'unknown' | 'declined' | 'conflicting';
export type DemandStatus = 'priority_discussion' | 'secondary_discussion' | 'defer' | 'insufficient_information' | 'review_existing';
export interface User { id:string; name:string; email:string; role:Role; orgId:string; emailVerified:boolean }
export interface Client { id:string; name:string; birthday:string; gender:string; phone:string; email:string; maritalStatus:string; state:string; language:string; ownerAgentId:string; consentStatus:string; createdAt:string }
export interface Case { id:string; clientId:string; ownerAgentId:string; status:string; entry:Category|null; createdAt:string; updatedAt:string; assignedReviewerId:string|null; reportVersion:number; clientName?:string; deletedAt?:string|null; deletedBy?:string|null }
export interface Message { id:string; caseId:string; sessionId:string; turnId:string; eventId:string; role:'user'|'assistant'; text:string; final:boolean; interrupted:boolean; createdAt:string; playbackStatus?:string; correctionOf?:string|null; source?:'customer'|'advisor'|'synthetic'; actorId?:string }
export function messageSource(message:Message):'customer'|'advisor'|'synthetic' {return message.source??(message.sessionId.startsWith('advisor-correction-')?'advisor':message.sessionId.startsWith('seed-')?'synthetic':'customer');}
export interface ProfileField { key:string; value:string|number|null; currency:string|null; period:string|null; factStatus:FactStatus; sourceMessageIds:string[]; confirmedBy:string|null; confirmedAt:string|null }
export interface AnalysisItem { category:Category; status:DemandStatus; evidenceRefs:string[]; reasonSummary:string; missingFields:string[]; constraints:string[]; nextQuestions:string[] }
export interface ReportInput { client:Client; owner:User; caseRecord:Case; version:number; snapshotId:string; reviewStatus:string; createdAt:string; facts:ProfileField[]; messages:Message[]; analyses:AnalysisItem[]; incompleteTranscript:boolean; provider:string; reviewNote?:string }
export interface ReportContent { caseId:string; clientId:string; version:number; snapshotId:string; reviewStatus:string; createdAt:string; ruleVersion:string; provider:string; title:string; summary:string; headerLines?:string[]; sections:{title:string;body:string}[]; fullText:string; analyses:AnalysisItem[]; facts:ProfileField[] }
export interface ReportRecord extends ReportContent { stale:boolean; recipientFingerprint:string; recipients:{email:string;name:string;verified:boolean}[]; pdfUrl:string; pdfReady:boolean }
export interface NotificationJob { id:string; caseId:string; reportVersion:number; recipient:string; status:string; body:string; attachmentUrl:string; approvalId:string; attempts:number; error:string|null }
export interface Review { id:string; caseId:string; reportVersion:number; reviewerId:string; decision:string; reason:string; createdAt:string }
export interface ReportJob { caseId:string; status:'queued'|'generating'|'ready'|'failed'; error:string|null; attempts:number; updatedAt:string }
export interface Settings { companyEmail:string; companyVerified:boolean; unreviewedSendPolicy:'pending'|'allow'|'reviewed_only'; mailMode:string }
export interface Bootstrap { usage?:UsageSummary; csrf:string; mode:'anonymous'|'advisor'|'client'; user:User|null; clients:Client[]; cases:Case[]; activeCase:Case|null; messages:Message[]; facts:ProfileField[]; reports:ReportRecord[]; reportJob?:ReportJob; notifications:NotificationJob[]; reviews:Review[]; settings?:Settings; users?:User[]; clientSession?:{id:string;state:string;entry:Category|null}; capabilities:{analysis:string;interview?:string;voice:string;voiceConfigured:boolean;mail:string}; demo:boolean }
