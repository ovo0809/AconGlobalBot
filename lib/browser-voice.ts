'use client';

export type BrowserVoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'paused' | 'ended' | 'error';

export interface BrowserVoiceOptions {
  csrf: string;
  onState?: (state: BrowserVoiceState) => void;
  onInterim?: (event: { role: 'user' | 'assistant'; text: string }) => void;
  onFinal?: (event: { role: 'user' | 'assistant'; text: string; interrupted: boolean }) => void;
  onError?: (message: string) => void;
  onInterrupted?: () => void;
  onMicPermission?: (granted: boolean) => void;
  readyTimeoutMs?: number;
}

type ServerEvent =
  | { type: 'ready'; inputSampleRate?: number; outputSampleRate?: number }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean; interrupted?: boolean }
  | { type: 'audio'; data: string; mimeType: string; itemId?: string }
  | { type: 'interrupted'; itemId?: string }
  | { type: 'turnComplete' | 'ending' | 'reconnecting' }
  | { type: 'closed'; retryable?: boolean }
  | { type: 'unavailable' | 'error'; message: string; code?: string; retryable?: boolean };

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToInt16(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

function downsampleToPcm16(input: Float32Array, inputRate: number, outputRate = 16_000) {
  const ratio = inputRate / outputRate;
  const output = new Int16Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(output.buffer);
}

export class BrowserVoiceClient {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private captureNode: AudioNode | null = null;
  private silentGain: GainNode | null = null;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private playbackCursor = 0;
  private playbackQueue:Promise<void>=Promise.resolve();
  private playbackGeneration=0;
  private inputSampleRate = 16_000;
  private outputSampleRate = 24_000;
  private outputItemId: string | null = null;
  private outputStartedAt = 0;
  private outputStartedAtContext:number|null=null;
  private outputReceivedMs = 0;
  private currentAudio: string[] = [];
  private lastAudio: string[] = [];
  private reconnectAttempts = 0;
  private captureChunks: Float32Array[] = [];
  private captureFrames = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private drainCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private paused = false;
  private isMuted = false;
  private voiceState: BrowserVoiceState = 'idle';
  private pageHide = () => { void this.pause(); };

  constructor(private options: BrowserVoiceOptions) {}
  get state() { return this.voiceState; }
  get muted() { return this.isMuted; }

  private setState(state: BrowserVoiceState) { this.voiceState = state; this.options.onState?.(state); }
  private error(message: string) { this.setState('error'); this.options.onError?.(message); }
  private safeReason(message:unknown,fallback='实时语音暂时不可用，您仍可用文字继续。'){
    if(typeof message!=='string'||!message.trim())return fallback;
    if(/费用|额度|上限|预算|spending/i.test(message))return '当前案例暂不能继续调用，请由顾问核对后重试。';
    return message.trim().slice(0,240).replace(/sk[-_][A-Za-z0-9_-]+/gi,'[已隐藏]').replace(/token=[^\s&]+/gi,'token=[已隐藏]');
  }
  private serverReason(event:Extract<ServerEvent,{type:'unavailable'|'error'}>){
    switch(event.code){
      case 'session_already_active':return '此访谈已在另一个页面进行，请回到该页面继续，或先结束那里的语音。';
      case 'session_closing':return '上一条语音连接正在保存收尾，请稍后再点击麦克风重试。';
      case 'spending_limit':return '当前案例暂不能启动语音，请顾问核对调用限制后重试。';
      case 'spending_protection':return '本次语音已触发应用保护并停止，已保存的回答会保留，请顾问核对后重试。';
      case 'voice_usage_unverified':return '语音服务未返回完整的调用记录，本次语音已停止。已保存的回答会保留，请顾问核对后重试。';
      case 'voice_duration_limit':return '本次连续语音已达到时长限制，已保存的回答会保留。请结束本次访谈。';
      case 'provider_quota':return '云端语音服务账户当前不可用，请顾问检查账户状态后重试。';
    }
    return this.safeReason(event.message);
  }
  private terminalError(message:string){this.intentionallyClosed=true;this.error(message);void this.closeResources(false);}

  async start() {
    if (!['idle', 'paused', 'error'].includes(this.voiceState)) return;
    this.intentionallyClosed = false;
    this.paused = false;
    this.reconnectAttempts = 0;
    this.setState('connecting');
    try {
      await this.ensureMicrophone();
      window.addEventListener('pagehide', this.pageHide);
      await this.connectSocket();
    } catch (cause) {
      await this.closeResources(false);
      throw cause;
    }
  }

  private async ensureMicrophone() {
    if (this.stream?.active) return;
    try {
      const hostname=typeof location==='undefined'?'localhost':location.hostname||location.host.split(':')[0];
      if (!globalThis.isSecureContext && hostname !== 'localhost' && hostname !== '127.0.0.1') throw new Error('当前页面不是安全连接，手机麦克风需要通过 HTTPS 访问。');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风访问，请使用受支持的浏览器或文字输入。');
      if(typeof AudioContext==='undefined')throw new Error('当前浏览器不支持连续语音所需的音频能力，请使用受支持的浏览器。');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.options.onMicPermission?.(true);
      await this.startCapture();
    } catch (cause) {
      this.options.onMicPermission?.(false);
      const knownCapabilityMessage=cause instanceof Error&&cause.message.startsWith('当前')?cause.message:null;
      const message=cause instanceof DOMException&&cause.name==='NotAllowedError'?'麦克风权限被拒绝，请在浏览器设置中允许后重试。':cause instanceof DOMException&&cause.name==='NotFoundError'?'未检测到可用麦克风，您仍可用文字继续。':knownCapabilityMessage??'无法启动浏览器音频，您仍可用文字继续。';
      this.error(message);
      throw cause;
    }
  }

  private async startCapture() {
    if (!this.stream) return;
    this.captureContext = new AudioContext({ latencyHint: 'interactive' });
    await this.captureContext.resume();
    const source = this.captureContext.createMediaStreamSource(this.stream);
    const emit = (samples: Float32Array) => {
      if (this.isMuted || this.socket?.readyState !== WebSocket.OPEN || this.voiceState === 'connecting') return;
      this.captureChunks.push(samples.slice());
      this.captureFrames += samples.length;
      const inputRate = this.captureContext?.sampleRate || 48_000;
      if (this.captureFrames < inputRate / 10) return;
      const joined = new Float32Array(this.captureFrames);
      let offset = 0;
      for (const chunk of this.captureChunks) { joined.set(chunk, offset); offset += chunk.length; }
      this.captureChunks = [];
      this.captureFrames = 0;
      const pcm = downsampleToPcm16(joined, inputRate, this.inputSampleRate);
      this.socket.send(JSON.stringify({ audio: bytesToBase64(pcm) }));
    };
    this.silentGain = this.captureContext.createGain();
    this.silentGain.gain.value = 0;
    if (this.captureContext.audioWorklet) {
      await this.captureContext.audioWorklet.addModule('/audio/aeconn-capture.js');
      const node = new AudioWorkletNode(this.captureContext, 'aeconn-capture');
      node.port.onmessage = (event: MessageEvent<Float32Array>) => emit(event.data);
      source.connect(node).connect(this.silentGain).connect(this.captureContext.destination);
      this.captureNode = node;
    } else {
      const node = this.captureContext.createScriptProcessor(2_048, 1, 1);
      node.onaudioprocess = (event) => emit(event.inputBuffer.getChannelData(0));
      source.connect(node).connect(this.silentGain).connect(this.captureContext.destination);
      this.captureNode = node;
    }
  }

  private async requestToken() {
    let response:Response;
    try{response=await fetch('/api/action', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': this.options.csrf }, body: JSON.stringify({ action: 'voiceToken' }) });}
    catch{throw new Error('无法连接语音服务，请检查网络后重试。');}
    let body:{token?:string;error?:string};
    try{body=await response.json() as {token?:string;error?:string};}catch{throw new Error('语音服务返回异常，请稍后重试。');}
    if (!response.ok || !body.token) throw new Error(this.safeReason(body.error,'无法获取语音会话凭证。'));
    return body.token;
  }

  private async connectSocket() {
    let token: string;
    try { token = await this.requestToken(); } catch (cause) { this.error(cause instanceof Error ? cause.message : '无法连接实时语音。'); throw cause; }
    if(typeof WebSocket==='undefined'){const cause=new Error('当前浏览器不支持实时语音网络连接，请使用受支持的浏览器。');this.error(cause.message);throw cause;}
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket:WebSocket;
    try{socket=new WebSocket(`${protocol}//${location.host}/voice?token=${encodeURIComponent(token)}`);}
    catch{const cause=new Error('无法建立实时语音连接，请检查网络和浏览器设置后重试。');this.error(cause.message);throw cause;}
    this.socket = socket;
    if(this.readyTimer)clearTimeout(this.readyTimer);
    this.readyTimer=setTimeout(()=>{if(this.socket===socket&&['connecting','reconnecting'].includes(this.voiceState))this.terminalError('实时语音连接超时，请检查网络后重试。');},this.options.readyTimeoutMs??10_000);
    socket.onmessage = (event) => this.handleServerEvent(event.data);
    socket.onerror = () => { if(this.socket===socket&&this.voiceState!=='error')this.options.onError?.('实时语音网络连接发生错误，正在等待连接结果。'); };
    socket.onclose = (event) => {
      if(this.readyTimer)clearTimeout(this.readyTimer);this.readyTimer=null;
      if (this.drainCloseTimer) clearTimeout(this.drainCloseTimer);
      this.drainCloseTimer = null;
      if (this.socket === socket) this.socket = null;
      if (!this.intentionallyClosed && !this.paused && event.code !== 1000 && this.reconnectAttempts < 2) {
        this.reconnectAttempts += 1;
        this.setState('reconnecting');
        this.reconnectTimer = setTimeout(() => { void this.connectSocket().catch(()=>undefined); }, 500 * this.reconnectAttempts);
      } else if (!this.intentionallyClosed && !this.paused && this.voiceState !== 'error') this.error('实时语音已断开，可继续使用文字或重新开始。');
    };
  }

  private handleServerEvent(raw: unknown) {
    if (typeof raw !== 'string') return;
    let event: ServerEvent;
    try { event = JSON.parse(raw) as ServerEvent; } catch { return; }
    if (this.intentionallyClosed && event.type !== 'ending') return;
    if (event.type === 'ready') {
      if(this.readyTimer)clearTimeout(this.readyTimer);this.readyTimer=null;
      if(event.inputSampleRate===16_000||event.inputSampleRate===24_000)this.inputSampleRate=event.inputSampleRate;
      if(event.outputSampleRate===24_000)this.outputSampleRate=event.outputSampleRate;
      this.setState('listening');
    }
    else if (event.type === 'transcript') {
      if (event.final) this.options.onFinal?.({ role: event.role, text: event.text, interrupted: Boolean(event.interrupted) });
      else this.options.onInterim?.({ role: event.role, text: event.text });
      if (event.role === 'user') this.setState(event.final ? 'thinking' : 'listening');
    } else if (event.type === 'audio') {
      if (!this.intentionallyClosed) {
        if(event.itemId&&event.itemId!==this.outputItemId){this.outputItemId=event.itemId;this.outputStartedAt=Date.now();this.outputStartedAtContext=null;this.outputReceivedMs=0;}
        this.outputReceivedMs+=this.pcmDurationMs(event.data);
        this.currentAudio.push(event.data); this.setState('speaking');
        const generation=this.playbackGeneration;
        this.playbackQueue=this.playbackQueue.then(()=>this.playPcm(event.data,generation));
      }
    }
    else if (event.type === 'interrupted') {
      const itemId=event.itemId||this.outputItemId;
      const contextPlayed=this.playbackContext&&this.outputStartedAtContext!==null?(this.playbackContext.currentTime-this.outputStartedAtContext)*1_000:Date.now()-this.outputStartedAt;
      const playedMs=Math.max(0,Math.min(this.outputReceivedMs,contextPlayed));
      this.stopPlayback();this.currentAudio=[];
      if(itemId&&this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({truncate:{itemId,audioEndMs:Math.round(playedMs)}}));
      this.outputItemId=null;this.outputReceivedMs=0;this.options.onInterrupted?.();this.setState('listening');
    }
    else if (event.type === 'turnComplete') { if (this.currentAudio.length) this.lastAudio = [...this.currentAudio]; this.currentAudio = []; this.outputItemId=null;this.outputStartedAtContext=null;this.outputReceivedMs=0;this.setState('listening'); }
    else if (event.type === 'reconnecting') { this.stopPlayback(); this.setState('reconnecting'); }
    else if (event.type === 'ending' && !this.intentionallyClosed) void this.stopAll();
    else if (event.type === 'unavailable' || event.type === 'error') {
      this.terminalError(this.serverReason(event));
    }
  }

  private async playPcm(encoded: string,generation=this.playbackGeneration) {
    if (!this.playbackContext) this.playbackContext = new AudioContext({ sampleRate: this.outputSampleRate, latencyHint: 'interactive' });
    await this.playbackContext.resume();
    if(generation!==this.playbackGeneration)return;
    const pcm = base64ToInt16(encoded);
    const buffer = this.playbackContext.createBuffer(1, pcm.length, this.outputSampleRate);
    const output = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) output[index] = pcm[index] / (pcm[index] < 0 ? 0x8000 : 0x7fff);
    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);
    this.playbackCursor = Math.max(this.playbackContext.currentTime, this.playbackCursor);
    if(this.outputStartedAtContext===null)this.outputStartedAtContext=this.playbackCursor;
    source.start(this.playbackCursor);
    this.playbackCursor += buffer.duration;
    this.playbackSources.add(source);
    source.onended = () => this.playbackSources.delete(source);
  }

  private pcmDurationMs(encoded:string){
    const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
    const bytes=Math.max(0,Math.floor(encoded.length*3/4)-padding);
    return bytes/2/this.outputSampleRate*1_000;
  }

  sendText(text: string) {
    const normalized = text.trim().slice(0, 2_000);
    if (!normalized || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ text: normalized }));
    this.setState('thinking');
    return true;
  }
  setMuted(muted: boolean) { this.isMuted = muted; for (const track of this.stream?.getAudioTracks() || []) track.enabled = !muted; }
  stopPlayback() { this.playbackGeneration+=1;this.playbackQueue=Promise.resolve();for (const source of this.playbackSources) { try { source.stop(); } catch {} } this.playbackSources.clear(); this.playbackCursor = this.playbackContext?.currentTime || 0; }
  async replayLast() { this.stopPlayback();const generation=this.playbackGeneration;for (const chunk of this.lastAudio) await this.playPcm(chunk,generation); }
  async pause() { if (this.voiceState === 'paused' || this.voiceState === 'ended') return; this.paused = true; await this.closeResources(false); this.setState('paused'); }
  async resume() {
    if (!this.paused) return;
    this.paused = false;
    this.setState('connecting');
    try { await this.ensureMicrophone(); window.addEventListener('pagehide',this.pageHide); await this.connectSocket(); }
    catch (cause) { await this.closeResources(false); throw cause; }
  }
  async stopAll() {
    this.intentionallyClosed = true;
    this.paused = false;
    await this.closeResources(true, true);
    this.setState('ended');
    if (this.drainCloseTimer) clearTimeout(this.drainCloseTimer);
    this.drainCloseTimer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, 'drain timeout');
    }, 3_000);
  }

  private async closeResources(final: boolean, keepSocket = false) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if(this.readyTimer)clearTimeout(this.readyTimer);
    this.readyTimer=null;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ audioStreamEnd: true }));
      if (!keepSocket) this.socket.close(1000, final ? 'ended' : 'paused');
    }
    if (!keepSocket) this.socket = null;
    this.stopPlayback();
    this.captureNode?.disconnect(); this.silentGain?.disconnect(); this.captureNode = null; this.silentGain = null;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    await this.captureContext?.close().catch(() => undefined); await this.playbackContext?.close().catch(() => undefined);
    this.captureContext = null; this.playbackContext = null;
    this.captureChunks = []; this.captureFrames = 0;
    window.removeEventListener('pagehide', this.pageHide);
  }
}
