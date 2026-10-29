/* global AudioWorkletProcessor, registerProcessor */

class AeconnCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor('aeconn-capture', AeconnCapture);
