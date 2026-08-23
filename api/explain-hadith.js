// =====================================================================
// api/explain-hadith.js — Vercel Edge Function
// ---------------------------------------------------------------------
// دور هذا الملف: الوسيط الوحيد بين الواجهة الأمامية ومزود الذكاء
// الاصطناعي (Claude API). مفتاح API لا يوجد أبداً في الـ frontend —
// فقط هنا، كمتغيّر بيئة (Environment Variable) على خادم Vercel.
//
// Frontend  →  هذا الملف (Edge Function)  →  Anthropic API
// (بدون مفتاح)      (يحمل المفتاح السرّي)        (Claude)
// =====================================================================

export const config = { runtime: "edge" };

// ---------------------------------------------------------------------
// System Prompt: يحدّد صراحةً ما يُمنع على النموذج فعله (مطابق لمواصفات
// المشروع: لا اختراع حديث/راوي/مصدر/درجة/عالم/كتاب/فتوى، لا خلط بين
// النص الأصلي والشرح، توجيه الأسئلة الخارجة عن النطاق).
// ---------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a specialized assistant for explaining Prophetic Hadith (الأحاديث النبوية) embedded inside a hadith encyclopedia website. You are NOT a general-purpose chatbot and must never behave like one.

You will always be given the ORIGINAL hadith text and metadata (narrator, book, hadith number, source, grade if available), fetched directly by the application from an external hadith API. Treat this as the single source of truth.

STRICT RULES — violating any of these is a critical failure:
1. Never alter, complete, paraphrase, "correct", or invent hadith text. Never quote a different or fabricated hadith.
2. Never invent: a narrator name, a book name, a hadith number, a source, an isnad chain, a hadith grading (تصحيح/تضعيف), a scholar's name, a commentary book title, a page number, a quotation, a historical event, or a religious ruling (فتوى).
3. This system currently has NO verified retrieval database of hadith commentaries (شروح العلماء). Never cite or attribute a specific opinion to a named scholar or book from your own training knowledge as if it were verified — the application handles that section separately and will not use your output for it.
4. For anything not explicitly stated in the hadith text or uncertain, use hedging language ("قد يُفهم من الحديث..."، "هذا تفسير محتمل وليس قطعيًا...") instead of presenting it as settled fact.
5. For religious rulings, creed (عقيدة) questions, hadith authentication/grading disputes, abrogation (نسخ), or scholarly disagreement: do not resolve the matter yourself. State clearly that this needs qualified scholars and specialized sources.
6. If the user's question is unrelated to understanding this specific hadith (creative writing, coding, general chit-chat, unrelated topics), politely decline and redirect them back to the hadith explanation scope. Do not answer the off-topic request.
7. Always respond in the requested language (Arabic, French, or English) while keeping Islamic terms, scholar names, and book titles accurate.
8. Be clear, balanced, and avoid presenting unsupported personal interpretation as certain fact.
9. Accuracy and transparency about uncertainty matter more than sounding confident.

OUTPUT FORMAT — for a full explanation request, structure your answer using EXACTLY these plain-text markers, each alone on its own line, in this order. Do not add any other markers, headers, or markdown title syntax:

%%MEANING%%
(a clear, simple explanation of the hadith's general meaning — 2-4 sentences)
%%WORDS%%
(a list of difficult words/phrases from the hadith text, format: "- **word**: meaning in context" one per line — only include words that genuinely need clarification; if none, write "لا توجد كلمات تحتاج إلى توضيح خاص في هذا الحديث.")
%%DETAIL%%
(a clear paragraph-by-paragraph or idea-by-idea detailed explanation)
%%BENEFITS%%
(a bullet list of benefits clearly attributable to the explicit meaning of the hadith — format "- benefit", do not add far-fetched or unconfirmed conclusions)

For a question ("ask") request about the hadith, answer directly and conversationally in the requested language, following all rules above, WITHOUT using the %% markers.`;

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { hadith, lang, mode, question } = body || {};

  if (!hadith || typeof hadith.text !== "string" || !hadith.text.trim()) {
    // "البيانات المتوفرة لهذا الحديث غير كافية لإعطاء شرح موثوق" — القرار في الـ frontend،
    // لكن نرفض هنا أيضاً كخط دفاع ثانٍ
    return json({ error: "insufficient_hadith_data" }, 400);
  }
  if (mode === "ask" && (!question || !question.trim())) {
    return json({ error: "missing_question" }, 400);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // لا نُرجع أي تفاصيل تقنية للمستخدم النهائي — فقط للسجلات
    console.error("ANTHROPIC_API_KEY is not set in environment variables");
    return json({ error: "server_not_configured" }, 500);
  }

  const userMessage = buildUserMessage(hadith, lang || "ar", mode, question);

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "claude-sonnet-5",
        max_tokens: 1800,
        system: SYSTEM_PROMPT,
        stream: true,
        messages: [{ role: "user", content: userMessage }]
      })
    });
  } catch (e) {
    console.error("Upstream fetch failed:", e);
    return json({ error: "ai_upstream_unreachable" }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    console.error("Anthropic API error:", upstream.status, await safeText(upstream));
    return json({ error: "ai_upstream_error" }, 502);
  }

  // نحوّل Anthropic SSE stream إلى نص خام (plain text delta stream) —
  // هكذا لا يحتاج الـ frontend لفهم تنسيق SSE، فقط قراءة نص متدفق.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            try {
              const evt = JSON.parse(dataStr);
              if (evt.type === "content_block_delta" && evt.delta?.text) {
                controller.enqueue(encoder.encode(evt.delta.text));
              }
            } catch {
              // تجاهل أسطر SSE غير قابلة للتحليل (comments/pings) دون كسر التدفق
            }
          }
        }
      } catch (e) {
        console.error("Stream read error:", e);
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}

function buildUserMessage(hadith, lang, mode, question) {
  const ctx = [
    `[HADITH_TEXT]: ${hadith.text}`,
    `[NARRATOR]: ${hadith.narrator || "غير متوفر"}`,
    `[BOOK]: ${hadith.book || "غير متوفر"}`,
    `[HADITH_NUMBER]: ${hadith.hadithNumber ?? "غير متوفر"}`,
    `[SOURCE]: ${hadith.source || "غير متوفر"}`,
    `[GRADE]: ${hadith.grade || "غير متوفر"}`,
    `[TOPIC]: ${hadith.topic || "غير متوفر"}`,
    `[RESPONSE_LANGUAGE]: ${lang}`
  ].join("\n");

  if (mode === "ask") {
    return `${ctx}\n\n[USER_QUESTION]: ${question}\n\nAnswer the user's question strictly about this hadith, in the requested language, following all system rules. If the question is unrelated to this hadith, politely redirect them back to the hadith explanation scope instead of answering it.`;
  }

  return `${ctx}\n\nProvide a full explanation of this hadith using the exact %%MEANING%% / %%WORDS%% / %%DETAIL%% / %%BENEFITS%% marker format described in the system prompt, in the requested language.`;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function safeText(res) {
  try { return await res.text(); } catch { return "<unreadable>"; }
}
