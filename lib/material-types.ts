import type { MaterialImportSource } from './material-import-types';
export type MaterialState = 'queued'|'processing'|'needs_review'|'approved'|'failed'|'withdrawn'|'deleted';
export type MaterialProvider = 'mock'|'openai';
export interface MaterialSummary {
  id:string; title:string; filename:string; kind:'image'|'video'; state:MaterialState;
  provider:MaterialProvider; caseId:string; createdAt:string; updatedAt:string; version:number; error:string|null;
  scope?:'case'|'library'|'organization';
}
export interface MaterialEvent {at:string;action:string;detail:string}
export interface MaterialCheckIssue {startSeconds:number;endSeconds:number;message:string}
export interface MaterialAudioRepair {
  key:string;partPosition:number;startSeconds:number;endSeconds:number;
  status:'started'|'done'|'failed';error?:string;
  result?:{durationSeconds:number;segments:Array<{startSeconds:number;endSeconds:number;text:string}>;timingWarning?:string};
}
export interface MaterialFrameRepair {timeSeconds:number;status:'started'|'done'|'failed';text?:string;imageSha256?:string;error?:string}
export interface MaterialAutoCheck {
  version:1;status:'running'|'checked'|'supplemented'|'attention';
  audio:MaterialAudioRepair[];frames:MaterialFrameRepair[];issues:MaterialCheckIssue[];
  sourceSha256?:string;stoppedReason?:string;
}
export interface MaterialPart {kind:'image'|'audio';position:number;startSeconds:number;endSeconds:number;state:'queued'|'done';text:string}
export interface MaterialDetail extends MaterialSummary {
  sourceNote:string; originalText:string; reviewedText:string; coverage:string;
  events:MaterialEvent[]; parts:MaterialPart[];
  importSource?:MaterialImportSource;
  autoCheck?:MaterialAutoCheck;
}
export const MATERIAL_MAX_TEXT_BYTES=64_000;
export const MATERIAL_MAX_ORIGINAL_BYTES=32*1024*1024;
export const MATERIAL_MAX_REQUEST_BYTES=64*1024*1024;
export const MATERIAL_MAX_VIDEO_SECONDS=600;
export const MATERIAL_MAX_STORAGE_BYTES=2*1024*1024*1024;
