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
}

type ServerEvent =
  | { type: 'ready' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean; interrupted?: boolean }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'interrupted' | 'turnComplete' | 'ending' }
  | { type: 'closed'; retryable?: boolean }
  | { type: 'unavailable' | 'error'; message: string };

const WORKLET_SOURCE = `class AeconnCapture extends AudioWorkletProcessor { process(inputs) { const channel = inputs[0] && inputs[0][0]; if (channel) this.port.postMessage(channel.slice()); return true; } } registerProcessor('aeconn-capture', AeconnCapture);`;

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
  private currentAudio: string[] = [];
  private lastAudio: string[] = [];
  private reconnectAttempts = 0;
  private captureChunks: Float32Array[] = [];
  private captureFrames = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

  async start() {
    if (!['idle', 'paused', 'error'].includes(this.voiceState)) return;
    this.intentionallyClosed = false;
    this.paused = false;
    this.reconnectAttempts = 0;
    this.setState('connecting');
    await this.ensureMicrophone();
    window.addEventListener('pagehide', this.pageHide);
    await this.connectSocket();
  }

  private async ensureMicrophone() {
    if (this.stream?.active) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('此浏览器不支持麦克风访问，请使用文字输入。');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.options.onMicPermission?.(true);
      await this.startCapture();
    } catch (cause) {
      this.options.onMicPermission?.(false);
      this.error(cause instanceof DOMException && cause.name === 'NotAllowedError' ? '麦克风权限被拒绝，可继续使用文字。' : '无法启动麦克风，可继续使用文字。');
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
      const pcm = downsampleToPcm16(joined, inputRate);
      this.socket.send(JSON.stringify({ audio: bytesToBase64(pcm) }));
    };
    this.silentGain = this.captureContext.createGain();
    this.silentGain.gain.value = 0;
    if (this.captureContext.audioWorklet) {
      const sourceUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      try { await this.captureContext.audioWorklet.addModule(sourceUrl); } finally { URL.revokeObjectURL(sourceUrl); }
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
    const response = await fetch('/api/action', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': this.options.csrf }, body: JSON.stringify({ action: 'voiceToken' }) });
    const body = await response.json() as { token?: string; error?: string };
    if (!response.ok || !body.token) throw new Error(body.error || '无法获取语音会话凭证。');
    return body.token;
  }

  private async connectSocket() {
    let token: string;
    try { token = await this.requestToken(); } catch (cause) { this.error(cause instanceof Error ? cause.message : '无法连接实时语音。'); throw cause; }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/voice?token=${encodeURIComponent(token)}`);
    this.socket = socket;
    socket.onmessage = (event) => this.handleServerEvent(event.data);
    socket.onerror = () => this.options.onError?.('实时语音连接发生错误。');
    socket.onclose = (event) => {
      if (this.drainCloseTimer) clearTimeout(this.drainCloseTimer);
      this.drainCloseTimer = null;
      if (this.socket === socket) this.socket = null;
      if (!this.intentionallyClosed && !this.paused && event.code !== 1000 && this.reconnectAttempts < 2) {
        this.reconnectAttempts += 1;
        this.setState('reconnecting');
        this.reconnectTimer = setTimeout(() => { void this.connectSocket(); }, 500 * this.reconnectAttempts);
      } else if (!this.intentionallyClosed && !this.paused && this.voiceState !== 'error') this.error('实时语音已断开，可继续使用文字或重新开始。');
    };
  }

  private handleServerEvent(raw: unknown) {
    if (typeof raw !== 'string') return;
    let event: ServerEvent;
    try { event = JSON.parse(raw) as ServerEvent; } catch { return; }
    if (this.intentionallyClosed && event.type !== 'ending') return;
    if (event.type === 'ready') { this.reconnectAttempts = 0; this.setState('listening'); }
    else if (event.type === 'transcript') {
      if (event.final) this.options.onFinal?.({ role: event.role, text: event.text, interrupted: Boolean(event.interrupted) });
      else this.options.onInterim?.({ role: event.role, text: event.text });
      if (event.role === 'user') this.setState(event.final ? 'thinking' : 'listening');
    } else if (event.type === 'audio') {
      if (!this.intentionallyClosed) { this.currentAudio.push(event.data); this.setState('speaking'); void this.playPcm(event.data); }
    }
    else if (event.type === 'interrupted') { this.stopPlayback(); this.options.onInterrupted?.(); this.setState('listening'); }
    else if (event.type === 'turnComplete') { if (this.currentAudio.length) this.lastAudio = [...this.currentAudio]; this.currentAudio = []; this.setState('listening'); }
    else if (event.type === 'ending' && !this.intentionallyClosed) void this.stopAll();
    else if (event.type === 'unavailable' || event.type === 'error') this.error(event.message);
  }

  private async playPcm(encoded: string) {
    if (!this.playbackContext) this.playbackContext = new AudioContext({ sampleRate: 24_000, latencyHint: 'interactive' });
    await this.playbackContext.resume();
    const pcm = base64ToInt16(encoded);
    const buffer = this.playbackContext.createBuffer(1, pcm.length, 24_000);
    const output = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) output[index] = pcm[index] / (pcm[index] < 0 ? 0x8000 : 0x7fff);
    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);
    this.playbackCursor = Math.max(this.playbackContext.currentTime, this.playbackCursor);
    source.start(this.playbackCursor);
    this.playbackCursor += buffer.duration;
    this.playbackSources.add(source);
    source.onended = () => this.playbackSources.delete(source);
  }

  sendText(text: string) {
    const normalized = text.trim().slice(0, 2_000);
    if (!normalized || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ text: normalized }));
    this.setState('thinking');
    return true;
  }
  setMuted(muted: boolean) { this.isMuted = muted; for (const track of this.stream?.getAudioTracks() || []) track.enabled = !muted; }
  stopPlayback() { for (const source of this.playbackSources) { try { source.stop(); } catch {} } this.playbackSources.clear(); this.playbackCursor = this.playbackContext?.currentTime || 0; }
  async replayLast() { this.stopPlayback(); for (const chunk of this.lastAudio) await this.playPcm(chunk); }
  async pause() { if (this.voiceState === 'paused' || this.voiceState === 'ended') return; this.paused = true; await this.closeResources(false); this.setState('paused'); }
  async resume() { if (!this.paused) return; this.paused = false; this.setState('connecting'); await this.ensureMicrophone(); await this.connectSocket(); }
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
