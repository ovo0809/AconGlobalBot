import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecordingWav, validateRecordingWav } from '../lib/recording-audio';
import { RECORDING_SAMPLE_RATE } from '../lib/recording-types';

test('录音分段自带完整 WAV 头，按真实采样数计算时长', () => {
  const samples = new Int16Array(RECORDING_SAMPLE_RATE * 60);
  samples[0] = -32_768; samples[1] = 32_767;
  const wav = encodeRecordingWav(samples);
  assert.equal(wav.length, 1_920_044);
  assert.deepEqual(validateRecordingWav(wav), {durationSeconds: 60, sampleCount: 960_000});
  const view = new DataView(wav.buffer);
  assert.equal(view.getInt16(44, true), -32_768);
  assert.equal(view.getInt16(46, true), 32_767);
  assert.deepEqual(validateRecordingWav(encodeRecordingWav(new Int16Array(8_000))), {durationSeconds: .5, sampleCount: 8_000});
});

test('服务器拒绝伪造时长、截断、错误格式和超过一分钟的分段', () => {
  assert.throws(() => encodeRecordingWav(new Int16Array(0)));
  assert.throws(() => encodeRecordingWav(new Int16Array(RECORDING_SAMPLE_RATE * 60 + 1)));
  const wav = encodeRecordingWav(new Int16Array(160));
  assert.throws(() => validateRecordingWav(wav.subarray(0, wav.length - 2)));
  for (const offset of [0, 4, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const invalid = wav.slice(); invalid[offset] ^= 1;
    assert.throws(() => validateRecordingWav(invalid), `offset ${offset}`);
  }
  const wrapped = new Uint8Array(wav.length + 8); wrapped.set(wav, 4);
  assert.equal(validateRecordingWav(wrapped.subarray(4, -4)).durationSeconds, .01);
});
