// app/widget/inline.js/route.ts
export const runtime = "edge";

export async function GET() {
  const js = `(() => {
    const s = document.currentScript;
    if (!s) return;

    const origin = s.dataset.origin || location.origin;
    const agentId = s.dataset.agentId || "";
    const label = s.dataset.label || "Talk to this article";
    const logo = s.dataset.logo || "";
    const width = s.dataset.width || "420px";
    const height = s.dataset.height || "120px";
    const fadeMs = 180;

    if (!agentId) {
      console.error("[dialogue-inline] Missing data-agent-id");
      return;
    }

    // Wrapper with fixed dimensions to prevent layout shift
    const wrap = document.createElement("div");
    wrap.style.font = "500 14px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    wrap.style.display = "inline-block";
    wrap.style.width = width;
    wrap.style.maxWidth = "100%";
    wrap.style.height = height;
    wrap.style.position = "relative";

    // CTA container (fills the box so click target is large)
    const ctaBox = document.createElement("div");
    ctaBox.style.position = "absolute";
    ctaBox.style.inset = "0";
    ctaBox.style.display = "flex";
    ctaBox.style.alignItems = "center";
    ctaBox.style.justifyContent = "center";
    ctaBox.style.background = "#fff";
    ctaBox.style.border = "1px solid rgba(0,0,0,.08)";
    ctaBox.style.borderRadius = "12px";
    ctaBox.style.boxShadow = "0 12px 30px rgba(0,0,0,.06)";
    ctaBox.style.transition = \`opacity \${fadeMs}ms ease\`;

    // Button
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.gap = "8px";
    btn.style.padding = "10px 14px";
    btn.style.borderRadius = "9999px";
    btn.style.border = "1px solid rgba(0,0,0,.12)";
    btn.style.background = "#fff";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 1px 2px rgba(0,0,0,.08)";
    btn.style.transition = "background 120ms ease, opacity 120ms ease";
    btn.onmouseenter = () => (btn.style.background = "#f8f8f8");
    btn.onmouseleave = () => (btn.style.background = "#fff");

    if (logo) {
      const img = document.createElement("img");
      img.src = logo;
      img.alt = "";
      img.setAttribute("aria-hidden", "true");
      img.width = 18;
      img.height = 18;
      img.referrerPolicy = "no-referrer";
      img.style.display = "block";
      img.style.borderRadius = "4px";
      btn.appendChild(img);
    }

    const span = document.createElement("span");
    span.textContent = label;
    span.style.fontWeight = "600";
    btn.appendChild(span);

    ctaBox.appendChild(btn);
    wrap.appendChild(ctaBox);

    // Mount the iframe (inline embed UI handles "Ready to start a dialogue…" + Start button)
    const mountIframe = () => {
      const frame = document.createElement("iframe");
      const params = new URLSearchParams({ agent_id: agentId, mode: "inline" });
      if (logo) params.set("logo", logo);

      frame.src = origin.replace(/\\/$/, "") + "/embed?" + params.toString();
      frame.allow = "microphone";
      frame.style.position = "absolute";
      frame.style.inset = "0";
      frame.style.width = "100%";
      frame.style.height = "100%";
      frame.style.border = "0";
      frame.style.borderRadius = "12px";
      frame.style.boxShadow = "0 12px 30px rgba(0,0,0,.06)";
      wrap.appendChild(frame);
    };

    btn.onclick = () => {
      // fade the CTA out, keep the wrapper size
      ctaBox.style.opacity = "0";
      btn.disabled = true;
      setTimeout(() => {
        // swap to iframe (ready state shows inside iframe)
        ctaBox.remove();
        mountIframe();
      }, fadeMs);
    };

    s.replaceWith(wrap);
  })();`;

  return new Response(js, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}