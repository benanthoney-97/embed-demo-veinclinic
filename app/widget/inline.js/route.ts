// app/widget/inline.js/route.ts
export const runtime = "edge";

export async function GET() {
  const js = `(() => {
    const s = document.currentScript;
    if (!s) return;

    const origin = s.dataset.origin || location.origin;
    const agentId = s.dataset.agentId || "";
    const label = s.dataset.label || "Talk to this article";

    if (!agentId) {
      console.error("[dialogue-inline] Missing data-agent-id");
      return;
    }

    // container
    const wrap = document.createElement("div");
    wrap.style.font = "500 14px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    wrap.style.display = "inline-block";

    // button (initial state)
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.padding = "10px 14px";
    btn.style.borderRadius = "9999px";
    btn.style.border = "1px solid rgba(0,0,0,.12)";
    btn.style.background = "#fff";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 1px 2px rgba(0,0,0,.08)";
    btn.onmouseenter = () => (btn.style.background = "#f8f8f8");
    btn.onmouseleave = () => (btn.style.background = "#fff");

    // frame placeholder (swapped in on click)
    const mountIframe = () => {
      const frame = document.createElement("iframe");
      const url = origin.replace(/\\/$/, "") + "/embed?agent_id=" +
                  encodeURIComponent(agentId) + "&mode=inline";
      frame.src = url;
      frame.allow = "microphone";
      frame.style.width = "420px";
      frame.style.maxWidth = "100%";
      frame.style.height = "120px"; // compact inline UI height
      frame.style.border = "0";
      frame.style.borderRadius = "12px";
      frame.style.boxShadow = "0 12px 30px rgba(0,0,0,.06)";

      wrap.innerHTML = "";
      wrap.appendChild(frame);
    };

    btn.onclick = () => mountIframe();

    wrap.appendChild(btn);
    s.replaceWith(wrap);
  })();`;

  return new Response(js, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}