export const RECORDING_SAMPLE_RATE = 16_000;
export const RECORDING_CHUNK_SECONDS = 60;
export const RECORDING_MAX_SECONDS = 7_200;
export const RECORDING_MAX_CHUNK_BYTES = 44 + RECORDING_SAMPLE_RATE * 2 * RECORDING_CHUNK_SECONDS;

export type RecordingState = 'recording' | 'paused' | 'queued' | 'transcribing' | 'review' | 'confirmed' | 'failed';
export type RecordingSpeaker = 'customer' | 'advisor' | 'unclear';
export interface RecordingSession {
  id:string; caseId:string; state:RecordingState; provider:'mock'|'openai'; createdAt:string;
  updatedAt:string; durationSeconds:number; chunkCount:number; transcribedChunks:number;
  incomplete:boolean; error:string|null;
}
export interface RecordingChunk {
  index:number; durationSeconds:number; offsetSeconds:number;
  status:'saved'|'transcribing'|'transcribed'|'failed'; audioAvailable:boolean;
}
export interface RecordingSegment {
  id:string; chunkIndex:number; startSeconds:number; endSeconds:number;
  originalText:string; text:string; speaker:RecordingSpeaker;
}
export interface RecordingDetail {
  session:RecordingSession|null; chunks:RecordingChunk[]; segments:RecordingSegment[];
  provider:'mock'|'openai'; configured:boolean;
}
export interface RecordingControlResult extends RecordingDetail { leaseToken?:string; nextIndex?:number; ok?:boolean }
