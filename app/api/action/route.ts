import { action, errorResponse } from '@/lib/service';
export const runtime='nodejs';
export async function POST(request:Request){try{return await action(request);}catch(error){return errorResponse(error);}}
