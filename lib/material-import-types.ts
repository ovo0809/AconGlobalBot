export const MATERIAL_IMPORT_CHUNK_BYTES=8*1024*1024;
export const MATERIAL_IMPORT_MAX_BYTES=2*1024*1024*1024;
export const MATERIAL_IMPORT_MAX_SECONDS=2*60*60;

export type MaterialImportState='uploading'|'queued'|'preparing'|'ready'|'failed'|'completed'|'cancelled';

export interface MaterialImportSegment {
  index:number;
  filename:string;
  startSeconds:number;
  endSeconds:number;
  bytes:number;
  sha256:string;
  materialId?:string;
}

export interface MaterialImportJob {
  id:string;
  requestId:string;
  title:string;
  sourceNote:string;
  caseId:string;
  filename:string;
  size:number;
  lastModified:number;
  state:MaterialImportState;
  receivedChunks:number;
  totalChunks:number;
  durationSeconds?:number;
  sourceHash?:string;
  segments:MaterialImportSegment[];
  error:string|null;
  createdAt:string;
  updatedAt:string;
}

export interface MaterialImportSource {
  jobId:string;
  index:number;
  filename:string;
  sourceHash:string;
  startSeconds:number;
  endSeconds:number;
}

// Short aliases keep server and UI call sites readable without changing the public shape.
export type ImportJob=MaterialImportJob;
export type ImportSegment=MaterialImportSegment;
