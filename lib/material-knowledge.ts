import { createHash } from 'node:crypto';
import { loadKnowledge, rankKnowledgeSources, selectKnowledgeSources, type KnowledgeContext } from './knowledge';
import { approvedMaterialDocuments } from './materials';

/** Private uploads are selected fresh for the authorized case owner, never put in the shared cache. */
export async function loadCaseKnowledge(caseId:string,query:string):Promise<KnowledgeContext>{
  const remote=await loadKnowledge(query);
  const documents=approvedMaterialDocuments(caseId);
  const personal=selectKnowledgeSources(documents,query);
  if(!personal.length)return remote;
  const sources=rankKnowledgeSources([...personal,...remote.sources],query);
  const revision=createHash('sha256').update(JSON.stringify(sources.map(source=>[source.id,source.revision]))).digest('hex');
  return {revision,sources,status:remote.status==='stale'?'stale':'ready',notices:remote.notices.filter(notice=>!notice.includes('没有找到')&&!notice.includes('没有可检索'))};
}
