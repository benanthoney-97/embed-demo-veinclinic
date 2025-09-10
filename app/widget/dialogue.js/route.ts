import { NextResponse } from "next/server";

export async function GET() {
  const js = `
(function () {
  function initDialogue() {
    document.querySelectorAll("[data-dialogue]").forEach((el) => {
      if (el.dataset.dialogueInitialized) return;
      el.dataset.dialogueInitialized = "true";

      const slug = el.getAttribute("slug") || el.dataset.slug;
      if (!slug) return;

      const iframe = document.createElement("iframe");
      iframe.src = "/d/" + slug + "?embed=1";
      iframe.style.width = "100%";
      iframe.style.border = "none";
      iframe.style.minHeight = "500px";

      el.appendChild(iframe);
    });
  }
  if (document.readyState !== "loading") initDialogue();
  else document.addEventListener("DOMContentLoaded", initDialogue);
})();`;

  return new NextResponse(js, {
    headers: { "Content-Type": "application/javascript" },
  });
}