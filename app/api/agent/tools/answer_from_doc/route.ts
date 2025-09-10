// app/api/agent/tools/answer_from_doc/route.ts
import { NextResponse } from "next/server";
export const runtime = "nodejs";

import { supabaseAdmin } from "@/lib/supabase";
import {
  Pinecone,
  type RecordMetadata,
  type ScoredPineconeRecord,
} from "@pinecone-database/pinecone";
import OpenAI from "openai";

/* ---------- constants (safe to read at build) ---------- */
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small"; // 1536-d
const GPT_MODEL = process.env.GPT_MODEL || "gpt-4o-mini";
const ELEVEN_TOOL_SECRET = process.env.ELEVEN_TOOL_SECRET; // optional enforcement
const MAX_CONTEXT_CHARS = 12_000;

/* ---------- lazy singletons (init only when route runs) ---------- */
let _openai: OpenAI | null = null;
let _index:
  | ReturnType<Pinecone["index"]>
  | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function getClients() {
  if (!_openai || !_index) {
    const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
    const PINECONE_API_KEY = requireEnv("PINECONE_API_KEY");
    const PINECONE_INDEX = requireEnv("PINECONE_INDEX");

    _openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
    _index = pc.index(PINECONE_INDEX);
  }
  return { openai: _openai!, index: _index! };
}

/* ==================== ROUTE ==================== */
export async function POST(req: Request) {
  const trace = getTraceId();
  const T0 = Date.now();

  try {
    /* ---- (optional) Auth for ElevenLabs webhook calls ---- */
    if (ELEVEN_TOOL_SECRET) {
      const auth = req.headers.get("x-eleven-tool-secret");
      if (auth !== ELEVEN_TOOL_SECRET) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    /* ---- read + normalize payload ---- */
    const raw = await req.text().catch(() => "");
    type Loose = Record<string, unknown>;
    const body: Loose = raw ? (JSON.parse(raw) as Loose) : {};

    // ElevenLabs may send { question: {...} } or flat
    const p = (body?.question as Loose) ?? (body?.query as Loose) ?? (body?.input as Loose) ?? body;
    const q = String((p?.q ?? p?.question ?? p?.prompt ?? "") as string).trim();
    const topK = clampInt((p?.topK ?? p?.topk ?? 5) as number, 1, 8);

    if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });

    let document_id = p?.document_id as string | undefined;
    let doc_version_id = p?.doc_version_id as string | undefined;
    const slug = p?.slug as string | undefined;

    /* ---- resolve IDs from slug if needed ---- */
    const Ts = Date.now();
    if ((!document_id || !doc_version_id) && slug) {
      const ss = await supabaseAdmin
        .from("share_surfaces")
        .select("document_id, live_version_id")
        .eq("page_slug", slug)
        .single();
      logLatency("answer_from_doc", trace, { step: "lookup_slug", ms: Date.now() - Ts, slug });

      if (ss.error || !ss.data) {
        return NextResponse.json({ error: "Unknown slug" }, { status: 404 });
      }
      document_id = ss.data.document_id;
      doc_version_id = ss.data.live_version_id;
    }

    if (!document_id || !doc_version_id) {
      return NextResponse.json(
        { error: "Provide slug or (document_id + doc_version_id)" },
        { status: 400 }
      );
    }

    /* ---- clients (now that we know we need them) ---- */
    const { openai, index } = getClients();

    /* ---- embed the user query ---- */
    const T1 = Date.now();
    const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: q });
    const vec = emb.data?.[0]?.embedding;
    logLatency("answer_from_doc", trace, { step: "embed", ms: Date.now() - T1, q_len: q.length });
    if (!vec) return NextResponse.json({ error: "Embedding failed" }, { status: 500 });

    /* ---- vector search in Pinecone ---- */
    const T2 = Date.now();
    const namespace = `doc:${document_id}:v:${doc_version_id}`;
    const res = await index.namespace(namespace).query({
      vector: vec,
      topK,
      includeMetadata: true,
    });
    const matches: ScoredPineconeRecord<RecordMetadata>[] = res.matches ?? [];
    logLatency("answer_from_doc", trace, { step: "pinecone_query", ms: Date.now() - T2, hits: matches.length });

    if (!matches.length) {
      const text = "I don’t have enough context from the document to answer that.";
      logLatency("answer_from_doc", trace, { step: "total", ms: Date.now() - T0, note: "no_hits" });
      return NextResponse.json({ ok: true, text, citations: [] });
    }

    /* ---- build grounded context from metadata.snippet only ---- */
    const contexts = matches
      .map((m, i) => {
        const idx = Number(m.metadata?.idx);
        const rawSnippet = String(m.metadata?.text_snippet ?? "");
        return `[#${i + 1} | idx ${Number.isFinite(idx) ? idx : "?"}]\n${rawSnippet}`;
      })
      .join("\n\n")
      .slice(0, MAX_CONTEXT_CHARS);

    const system = [
      "You are a careful assistant answering strictly from the provided document context.",
      "If the answer is not clearly supported, say you don’t know.",
      "Cite sources inline like [#1], [#2] based on the tags in the context.",
      "Be concise and avoid speculation.",
    ].join(" ");

    const userMsg = `Question:\n${q}\n\nContext:\n${contexts}`;

    /* ---- LLM answer ---- */
    const T4 = Date.now();
    const completion = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      temperature: 0.2,
    });
    const answer = completion.choices?.[0]?.message?.content?.trim() ?? "";
    logLatency("answer_from_doc", trace, {
      step: "llm",
      ms: Date.now() - T4,
      model: GPT_MODEL,
      chars_in: userMsg.length,
      chars_out: answer.length,
    });

    const citations = matches.map((m, i) => ({
      tag: `#${i + 1}`,
      idx: Number(m.metadata?.idx),
      path: (m.metadata?.path as string) ?? "root",
      excerpt: String(m.metadata?.text_snippet ?? "").slice(0, 300),
      score: m.score,
    }));

    logLatency("answer_from_doc", trace, {
      step: "total",
      ms: Date.now() - T0,
      hits: matches.length,
      topK,
    });

    return NextResponse.json({ ok: true, text: answer || "I don’t know.", citations });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr("answer_from_doc", trace, "fatal", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ==================== helpers ==================== */
function clampInt(v: unknown, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(n, max));
}
function getTraceId() {
  try {
    const g = globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } };
    return g.crypto?.randomUUID?.() ?? String(Date.now());
  } catch {
    return String(Date.now());
  }
}
function logLatency(scope: string, trace: string, data: Record<string, unknown>) {
  try { console.log(`[latency][${scope}] trace=${trace} ${JSON.stringify(data)}`); } catch {}
}
function logErr(scope: string, trace: string, msg: string, e?: unknown) {
  try { console.error(`[${scope}] trace=${trace} ${msg}:`, e); } catch {}
}