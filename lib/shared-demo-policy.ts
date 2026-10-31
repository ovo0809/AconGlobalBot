/** A shared preview is deliberately unable to enable paid providers. */
export function isSharedDemo(env:Record<string,string|undefined>=process.env) {
  return env.SHARE_DEMO_MODE==='mock';
}

export function assertSharedDemoEnvironment(env:Record<string,string|undefined>=process.env) {
  if(!env.SHARE_DEMO_MODE)return;
  if(!isSharedDemo(env))throw new Error('Shared demo supports mock mode only.');
  for(const selector of ['LLM_PROVIDER','VOICE_PROVIDER','RECORDING_PROVIDER']){
    if(env[selector]!=='mock')throw new Error(`Shared demo requires ${selector}=mock.`);
  }
  for(const secret of ['OPENAI_API_KEY','GEMINI_API_KEY']){
    if(env[secret]?.trim())throw new Error('Shared demo must not receive cloud API credentials.');
  }
  if(env.MAIL_MODE!=='dry_run')throw new Error('Shared demo requires preview-only mail.');
  if(env.HOST!=='127.0.0.1')throw new Error('Shared demo must bind to loopback.');
  if(!env.DATABASE_PATH)throw new Error('Shared demo requires its own database path.');
  let origin:URL;
  try{origin=new URL(env.HTTPS_PROXY_ORIGIN||'');}catch{throw new Error('Shared demo requires an HTTPS origin.');}
  if(origin.protocol!=='https:'||origin.origin!==env.HTTPS_PROXY_ORIGIN)throw new Error('Shared demo requires an exact HTTPS origin.');
  for(const [key,value] of [['AI_CASE_BUDGET_USD','8'],['AI_DAILY_BUDGET_USD','40'],['AI_MONTHLY_BUDGET_USD','160']]){
    if(env[key]!==value)throw new Error('Shared demo must preserve the agreed budget limits.');
  }
}
