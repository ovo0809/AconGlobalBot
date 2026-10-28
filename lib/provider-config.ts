/** Explicit cloud selection is required; incomplete cloud configuration never passes as mock success. */
export type OpenAITranscriptionModel='whisper-1'|'gpt-4o-mini-transcribe';
export interface CloudModelConfig { provider:'gemini'|'openai'; apiKey:string; model:string; transcriptionModel?:OpenAITranscriptionModel }

export function requireOpenAITranscriptionModel(value=process.env.OPENAI_TRANSCRIPTION_MODEL):OpenAITranscriptionModel {
  const model=value?.trim()||'gpt-4o-mini-transcribe';
  if(model!=='whisper-1'&&model!=='gpt-4o-mini-transcribe')throw new Error('Unsupported OPENAI_TRANSCRIPTION_MODEL.');
  return model;
}

function cloudConfig(selector:'LLM_PROVIDER'|'VOICE_PROVIDER',modelKey:'GEMINI_MODEL'|'GEMINI_LIVE_MODEL'):CloudModelConfig|null {
  if(process.env[selector]?.trim()==='openai'){
    const apiKey=process.env.OPENAI_API_KEY?.trim();
    const model=process.env[selector==='LLM_PROVIDER'?'OPENAI_MODEL':'OPENAI_REALTIME_MODEL']?.trim();
    return apiKey&&model?{provider:'openai',apiKey,model,...(selector==='VOICE_PROVIDER'?{transcriptionModel:requireOpenAITranscriptionModel()}: {})}:null;
  }
  if(process.env[selector]?.trim()!=='gemini') return null;
  const apiKey=process.env.GEMINI_API_KEY?.trim();
  const model=process.env[modelKey]?.trim();
  return apiKey&&model?{provider:'gemini',apiKey,model}:null;
}

export const analysisProviderConfig=()=>cloudConfig('LLM_PROVIDER','GEMINI_MODEL');
export const realtimeVoiceConfig=()=>cloudConfig('VOICE_PROVIDER','GEMINI_LIVE_MODEL');

export function requireAnalysisConfig():CloudModelConfig|null {
  const selected=process.env.LLM_PROVIDER?.trim();
  if(!selected||selected==='mock') return null;
  if(!['gemini','openai'].includes(selected)) throw new Error('Unsupported LLM_PROVIDER.');
  const config=analysisProviderConfig();
  if(!config) throw new Error('Cloud interview requires the selected provider API key and text model.');
  return config;
}

export function providerDisplayCapabilities(){
  const analysis=analysisProviderConfig(),voice=realtimeVoiceConfig();
  const cloudSelected=Boolean(process.env.LLM_PROVIDER&&process.env.LLM_PROVIDER!=='mock');
  return {
    analysis:analysis?`${analysis.provider}（未完成真实服务验收）`:cloudSelected?'云端配置不完整':'mock（模拟分析）',
    interview:analysis?'云端 AI 访谈（待真实验收）':cloudSelected?'云端配置不完整':'模拟访谈',
    voice:voice?`${voice.provider}（待真机验证）`:'实时语音未配置',
    voiceConfigured:Boolean(voice),
  };
}
