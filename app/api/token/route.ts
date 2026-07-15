import { GoogleGenAI } from "@google/genai";

export const runtime = "edge";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  if (origin && host && new URL(origin).host !== host) {
    return Response.json({ error: "Cross-origin token requests are not allowed." }, { status: 403 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Voice chat is not configured yet. Add GEMINI_API_KEY to the server environment." },
      { status: 503 },
    );
  }

  try {
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: "v1alpha" },
    });
    const now = Date.now();
    const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        httpOptions: { apiVersion: "v1alpha" },
      },
    });

    return Response.json(
      { token: token.name, expiresAt: expireTime },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to create a Gemini Live token", error);
    return Response.json({ error: "Gemini could not create a voice session right now." }, { status: 502 });
  }
}
