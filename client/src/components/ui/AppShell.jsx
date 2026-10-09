import React from 'react';
import { Sprout } from 'lucide-react';

// Field-journal shell: paper backdrop, centered column, header slot,
// message region (role=log, aria-live), sticky input slot.
// Narrow by default (max-w-2xl), wide variant reserves Phase-2 side rail.
const AppShell = ({
  title = 'SC-Main Field Journal',
  subtitle = 'Crop diagnosis and seed verification workspace',
  cases = null,
  messages = null,
  input = null,
  wide = false,
}) => (
  <div className="relative min-h-[100dvh] bg-paper text-ink font-body">
    <div className={`mx-auto flex flex-col min-h-[100dvh] ${wide ? 'max-w-3xl' : 'max-w-2xl'} px-4 md:px-6`}>
      <header className="z-10 shrink-0 border-b border-line py-4 flex items-center gap-3">
        <span className="w-10 h-10 rounded-full bg-accent text-accent-ink flex items-center justify-center" aria-hidden="true">
          <Sprout size={20} strokeWidth={1.5} />
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-[17px] font-semibold leading-tight truncate">{title}</h1>
          <p className="text-xs text-muted truncate">{subtitle}</p>
        </div>
      </header>

      {cases}

      <main role="log" aria-live="polite" aria-label="Conversation" className="flex-1 py-4">
        {messages}
      </main>

      <footer className="sticky bottom-0 z-10 bg-paper border-t border-line py-3">
        {input}
      </footer>
    </div>
  </div>
);

export default AppShell;
