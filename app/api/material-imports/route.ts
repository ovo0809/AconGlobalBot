import { materialImportRequest, errorResponse } from '@/lib/service';
export const runtime='nodejs';
export async function GET(request:Request){try{return await materialImportRequest(request);}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{return await materialImportRequest(request);}catch(error){return errorResponse(error);}}
export async function PUT(request:Request){try{return await materialImportRequest(request);}catch(error){return errorResponse(error);}}
