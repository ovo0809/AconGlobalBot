import { materialsRequest, errorResponse } from '@/lib/service';
export const runtime='nodejs';
export async function GET(request:Request){try{return await materialsRequest(request);}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{return await materialsRequest(request);}catch(error){return errorResponse(error);}}
