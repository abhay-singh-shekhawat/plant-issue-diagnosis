import React from 'react';
import ChatContainer from './components/chat/ChatContainer';
import AppShell from './components/ui/AppShell';
import ScButton from './components/ui/ScButton';
import ScInput from './components/ui/ScInput';
import StatusDot from './components/ui/StatusDot';
import Reveal from './components/ui/Reveal';
import { Mic } from 'lucide-react';
import { isVoiceAvailable, VOICE_TRANSPORT_UNAVAILABLE } from './voice/VoiceTransport';

// Phase 1 foundation preview (?ds=1): exercises the token-driven primitives
// without touching the default ChatContainer path. Not a product surface.
const FoundationPreview = () => (
  <AppShell
    messages={
      <div className="space-y-4">
        <Reveal>
          <p className="font-display text-lg font-semibold">Foundation primitives</p>
          <p className="text-sm text-muted">Buttons, inputs, status and ingress in token skin.</p>
        </Reveal>
        <Reveal delay={0.05}>
          <div className="flex flex-wrap gap-2">
            <ScButton>Primary action</ScButton>
            <ScButton variant="secondary">Secondary</ScButton>
            <ScButton disabled>Sending</ScButton>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <ScInput label="Field note" helper="Label above, helper in markup." placeholder="Type a note" />
        </Reveal>
        <Reveal delay={0.15}>
          <ScInput label="Problem" error="Describe the visible symptom." placeholder="Yellow spots" />
        </Reveal>
        <div className="flex flex-wrap gap-4">
          <StatusDot status="gathering" label="Gathering" />
          <StatusDot status="evaluating" label="Evaluating" />
          <StatusDot status="completed" label="Completed" />
        </div>
        <Reveal delay={0.2}>
          <button
            type="button"
            disabled
            title="Web voice is not available yet. Text and photo input remain fully supported."
            className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-full text-sm border border-line text-muted opacity-50 cursor-not-allowed"
          >
            <Mic size={16} strokeWidth={1.5} aria-hidden="true" />
            Voice {isVoiceAvailable() ? 'ready' : 'later'} ({VOICE_TRANSPORT_UNAVAILABLE})
          </button>
        </Reveal>
      </div>
    }
    input={<ScButton className="w-full">Input slot reserved for Phase 2 chat skin</ScButton>}
  />
);

function App() {
  const preview =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('ds') === '1';
  if (preview) return <FoundationPreview />;
  return <ChatContainer />;
}

export default App;
