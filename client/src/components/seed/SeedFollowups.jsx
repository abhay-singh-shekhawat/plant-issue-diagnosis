import React, { useState } from 'react';
import { Send } from 'lucide-react';

// Follow-up interactions for an active seed case.
// Everything sent here is plain text over the existing /api/message
// contract with explicit domain. Marker formats mirror the backend
// parsers exactly (parseBrandedSlots: "price: N", "seller: NAME",
// "scheme: X"; parseCropVarietyClaim: "crop: X", "variety: Y";
// PACKET_CONFIRM_CUES: "same packet"). Nothing is inferred from
// replies here; assistant text renders unchanged in the transcript.
const SeedFollowups = ({ mode = 'open', disabled = false, onSend }) => {
  const [seller, setSeller] = useState('');
  const [price, setPrice] = useState('');
  const [formError, setFormError] = useState('');

  const sendSellerPrice = (e) => {
    if (e) e.preventDefault();
    if (disabled) return;
    const s = seller.trim().slice(0, 60);
    const digits = price.replace(/[^0-9]/g, '').slice(0, 6);
    if (!s && digits.length < 2) {
      setFormError('Add a seller name or a price (2-6 digits).');
      return;
    }
    setFormError('');
    const parts = [];
    if (s) parts.push(`seller: ${s}`);
    if (digits.length >= 2) parts.push(`price: ${digits}`);
    setSeller('');
    setPrice('');
    onSend(parts.join(' '));
  };

  return (
    <div aria-label="Seed follow-ups" className="py-2 space-y-2 shrink-0">
      {mode === 'branded' ? (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSend('same packet')}
              title="Use when the photo above already shows the packet clearly"
              className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full text-xs font-medium bg-surface text-ink border border-line hover:bg-mist disabled:opacity-50 disabled:cursor-wait active:scale-[0.98]"
            >
              Same packet photo
            </button>
          </div>
          <p className="text-[12px] text-muted">
            If the photo above already shows the packet, send that. You can also
            type details the workflow reads, such as price: 450 or seller: name.
          </p>
        </>
      ) : (
        <>
          {formError && (
            <div role="alert" className="text-xs text-danger bg-dangerwash border border-line rounded-input px-3 py-2">
              {formError}
            </div>
          )}
          <form onSubmit={sendSellerPrice} className="flex flex-col sm:flex-row gap-2">
            <label htmlFor="seed-seller" className="sr-only">Seller or shop name</label>
            <input
              id="seed-seller"
              type="text"
              value={seller}
              onChange={(e) => setSeller(e.target.value)}
              placeholder="Seller or shop name"
              disabled={disabled}
              maxLength={60}
              className="flex-1 min-w-0 px-4 py-2 min-h-[44px] rounded-full border border-line bg-surface text-ink text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-mist disabled:text-muted"
            />
            <label htmlFor="seed-price" className="sr-only">Price in rupees</label>
            <input
              id="seed-price"
              type="text"
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Price (Rs.)"
              disabled={disabled}
              maxLength={12}
              className="sm:w-36 px-4 py-2 min-h-[44px] rounded-full border border-line bg-surface text-ink text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-mist disabled:text-muted"
            />
            <button
              type="submit"
              disabled={disabled}
              aria-label="Send seller and price"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full text-xs font-medium bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50 disabled:cursor-wait active:scale-[0.98]"
            >
              <Send size={14} strokeWidth={1.75} aria-hidden="true" />
              Send details
            </button>
          </form>
          <p className="text-[12px] text-muted">
            Sent as typed details only. You can also type crop: paddy variety:
            Swarna. Reference checks use internal sample data, never official records.
          </p>
        </>
      )}
    </div>
  );
};

export default SeedFollowups;
