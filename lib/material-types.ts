import type { MaterialImportSource } from './material-import-types';
export type MaterialState = 'queued'|'processing'|'needs_review'|'approved'|'failed'|'withdrawn';
export type MaterialProvider = 'mock'|'openai';
export interface MaterialSummary {
  id:string; title:string; filename:string; kind:'image'|'video'; state:MaterialState;
  provider:MaterialProvider; caseId:string; createdAt:string; updatedAt:string; version:number; error:string|null;
  scope?:'case'|'library'|'organization';
}
export interface MaterialEvent {at:string;action:string;detail:string}
export interface MaterialPart {kind:'image'|'audio';position:number;startSeconds:number;endSeconds:number;state:'queued'|'done';text:string}
export interface MaterialDetail extends MaterialSummary {
  sourceNote:string; originalText:string; reviewedText:string; coverage:string;
  events:MaterialEvent[]; parts:MaterialPart[];
  importSource?:MaterialImportSource;
}
export const MATERIAL_MAX_TEXT_BYTES=64_000;
export const MATERIAL_MAX_ORIGINAL_BYTES=32*1024*1024;
export const MATERIAL_MAX_REQUEST_BYTES=64*1024*1024;
export const MATERIAL_MAX_VIDEO_SECONDS=600;
export const MATERIAL_MAX_STORAGE_BYTES=2*1024*1024*1024;
