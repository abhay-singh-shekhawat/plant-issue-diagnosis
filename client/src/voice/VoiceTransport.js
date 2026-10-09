// VoiceTransport: Phase 1 interface stub ONLY.
// No endpoint, no audio code, no fake success. The Web voice backend
// transport does not exist yet, so every method rejects with
// VOICE_TRANSPORT_UNAVAILABLE. A later approved backend task provides
// the real bridge; UI composes against this interface, never a URL.

export const VOICE_TRANSPORT_UNAVAILABLE = 'VOICE_TRANSPORT_UNAVAILABLE';

const unavailable = async () => {
  const err = new Error(
    'Web voice transport is not available yet. Text and photo input remain fully supported.'
  );
  err.code = VOICE_TRANSPORT_UNAVAILABLE;
  throw err;
};

// Interface: startRecording / stopRecording / cancel / getDuration /
// sendVoice / onState. Signature frozen for the future bridge.
export const NotAvailableTransport = {
  kind: 'not-available',
  startRecording: unavailable,
  stopRecording: unavailable,
  cancel: async () => {},
  getDuration: () => 0,
  sendVoice: unavailable,
  onState: () => () => {},
};

export const getVoiceTransport = () => NotAvailableTransport;

export const isVoiceAvailable = () => false;
