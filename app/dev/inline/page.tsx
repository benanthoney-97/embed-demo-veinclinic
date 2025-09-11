// app/dev/inline/page.tsx
'use client';

import Script from 'next/script';

export default function InlineDemoPage() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>

      {/* Inline widget mounts here */}
      <Script
        src="/widget/inline.js"
        strategy="afterInteractive"
        data-agent-id="agent_1301k4s38an5f1taqs2dsgh32eke"
        data-label="Talk to this article"
        data-logo="https://mnuvflcglofttsmsqilc.supabase.co/storage/v1/object/public/dialogue-assets/Frame%2010.png"
        // Optional:
        // data-width="420px"
        // data-height="120px"
      />
    </main>
  );
}