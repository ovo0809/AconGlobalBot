import type { KnowledgeContext, KnowledgeSource } from './knowledge';

/** Internal views only. The endpoint separately checks the signed-in owner. */
export function safeMaterialSourceUrl(source:KnowledgeSource):string|null {
  if(!/^[a-f0-9]{64}$/.test(source.revision))return null;
  const id=source.path.match(/^uploads\/([a-f0-9-]{36})\//)?.[1];if(!id)return null;
  const expected=`/api/materials?id=${id}&revision=${source.revision}`;
  return source.url===expected||source.url.startsWith(`${expected}#L`)?expected:null;
}

/** Public customer responses may expose only this repository's pinned public files. */
export function safeKnowledgeUrl(source: KnowledgeSource): string | null {
  try {
    const url=new URL(source.url);
    const match=url.pathname.match(/^\/ovo0809\/AconGlobalBot\/blob\/([a-f0-9]{40})\/(knowledge\/[^?#]+)$/);
    if(url.protocol!=='https:'||url.host!=='github.com'||url.username||url.password||url.search||!match||match[1]!==source.revision)return null;
    const decoded=decodeURIComponent(match[2]);
    if(decoded!==source.path||decoded.includes('\\')||decoded.split('/').some(part=>part==='.'||part==='..'||!part))return null;
    return url.toString();
  }catch{return null;}
}

export function publicKnowledgeContext(context: KnowledgeContext | undefined): KnowledgeContext | undefined {
  if(!context)return undefined;
  const sources=context.sources.filter(source=>safeKnowledgeUrl(source));
  if(!sources.length)return undefined;
  // Operational notices can contain local paths; keep them in the advisor view.
  return {revision:context.revision,status:context.status,notices:[],sources};
}
