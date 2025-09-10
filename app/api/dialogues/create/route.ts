// app/api/dialogues/create/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
function randomSuffix(n = 8) {
  return Math.random().toString(16).slice(2, 2 + n);
}

type CreateDialogueBody = {
  title: string;
  pageSlugBase: string;
  objectPath: string;
  mode?: "development" | "production";
  privacy?: "private" | "public";
};

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<CreateDialogueBody>;

    const {
      title,
      pageSlugBase,
      objectPath,
      mode = "development",
      privacy = "private",
    } = parsed;

    if (!title || !pageSlugBase || !objectPath) {
      return NextResponse.json(
        { error: "title, pageSlugBase, objectPath required" },
        { status: 400 }
      );
    }

    // 1) documents
    const docSlug = `${slugify(pageSlugBase)}-${randomSuffix(8)}`;
    const docIns = await supabaseAdmin
      .from("documents")
      .insert([{ title, slug: docSlug }])
      .select("id, slug")
      .single();

    if (docIns.error || !docIns.data) {
      return NextResponse.json(
        { error: docIns.error?.message || "documents insert failed" },
        { status: 500 }
      );
    }
    const document_id = docIns.data.id as string;

    // 2) doc_versions
    const verIns = await supabaseAdmin
      .from("doc_versions")
      .insert([{ document_id, source_uri: objectPath, version: 1 }])
      .select("id, status, version, source_uri")
      .single();

    if (verIns.error || !verIns.data) {
      return NextResponse.json(
        { error: verIns.error?.message || "doc_versions insert failed" },
        { status: 500 }
      );
    }
    const doc_version_id = verIns.data.id as string;

    // 3) share_surfaces
    const page_slug = docSlug;
    const page_url = `/d/${page_slug}`;

    const surfIns = await supabaseAdmin
      .from("share_surfaces")
      .insert([
        {
          document_id,
          live_version_id: doc_version_id,
          page_slug,
          page_url,
          mode,
          privacy,
        },
      ])
      .select("document_id, live_version_id, page_slug, page_url")
      .single();

    if (surfIns.error || !surfIns.data) {
      return NextResponse.json(
        { error: surfIns.error?.message || "share_surfaces insert failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      document_id,
      doc_version_id,
      page_slug,
      page_url,
      title,
      source_uri: objectPath,
      mode,
      privacy,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}