import { errorResponse, recordingRequest } from '@/lib/service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{return await recordingRequest(request);}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{return await recordingRequest(request);}catch(error){return errorResponse(error);}}
