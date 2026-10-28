import { bootstrap, errorResponse } from '@/lib/service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(request:Request){try{return bootstrap(request);}catch(error){return errorResponse(error);}}
