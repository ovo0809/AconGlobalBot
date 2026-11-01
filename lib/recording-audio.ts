import { RECORDING_CHUNK_SECONDS, RECORDING_MAX_CHUNK_BYTES, RECORDING_SAMPLE_RATE } from './recording-types';

// Independent WAV files let each saved minute survive an interrupted browser session.
export function encodeRecordingWav(pcm: Int16Array): Uint8Array {
  if (!pcm.length || pcm.length > RECORDING_SAMPLE_RATE * RECORDING_CHUNK_SECONDS) {
    throw new Error('录音分段必须介于一个采样点与 60 秒之间。');
  }
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE');
  label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, RECORDING_SAMPLE_RATE, true);
  view.setUint32(28, RECORDING_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

export function validateRecordingWav(bytes: Uint8Array): {durationSeconds: number; sampleCount: number} {
  if (bytes.byteLength < 46 || bytes.byteLength > RECORDING_MAX_CHUNK_BYTES || bytes.byteLength % 2 !== 0) {
    throw new Error('录音分段大小无效，单段最多 60 秒。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (offset: number, value: string) => [...value].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (!label(0, 'RIFF') || !label(8, 'WAVE') || !label(12, 'fmt ') || !label(36, 'data') ||
      view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== RECORDING_SAMPLE_RATE || view.getUint32(28, true) !== RECORDING_SAMPLE_RATE * 2 ||
      view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      view.getUint32(40, true) !== bytes.byteLength - 44) {
    throw new Error('录音分段必须是单声道 16 kHz PCM16 WAV。');
  }
  const sampleCount = (bytes.byteLength - 44) / 2;
  return {durationSeconds: sampleCount / RECORDING_SAMPLE_RATE, sampleCount};
}
