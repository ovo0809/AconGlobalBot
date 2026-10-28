/** Prototype defaults never activate an API merely because credentials exist. */
export interface CloudModelConfig { provider:'gemini'; apiKey:string; model:string }

function cloudConfig(selector:'LLM_PROVIDER'|'VOICE_PROVIDER',modelKey:'GEMINI_MODEL'|'GEMINI_LIVE_MODEL'):CloudModelConfig|null {
  if(process.env[selector]?.trim()!=='gemini') return null;
  const apiKey=process.env.GEMINI_API_KEY?.trim();
  const model=process.env[modelKey]?.trim();
  return apiKey&&model?{provider:'gemini',apiKey,model}:null;
}

export const analysisProviderConfig=()=>cloudConfig('LLM_PROVIDER','GEMINI_MODEL');
export const realtimeVoiceConfig=()=>cloudConfig('VOICE_PROVIDER','GEMINI_LIVE_MODEL');

export function providerDisplayCapabilities(){
  const analysis=analysisProviderConfig(),voice=realtimeVoiceConfig();
  return {
    analysis:analysis?`${analysis.provider}（未完成真实服务验收）`:'mock（模拟分析）',
    voice:voice?`${voice.provider}（待真机验证）`:'实时语音未配置',
    voiceConfigured:Boolean(voice),
  };
}
