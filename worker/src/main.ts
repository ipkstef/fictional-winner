import { handleConvertRoute } from "./routes/convert";
import { getErrorHtml, getIndexHtml } from "./ui/html";

export interface Env {
  DB: D1Database;
  CATEGORY_ID: string;
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const htmlHeaders: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/" || url.pathname === "") {
        return new Response(request.method === "HEAD" ? null : getIndexHtml(), {
          status: 200,
          headers: htmlHeaders,
        });
      }
      return new Response(
        request.method === "HEAD" ? null : getErrorHtml("Not Found"),
        { status: 404, headers: htmlHeaders },
      );
    }

    if (request.method === "POST" && url.pathname === "/convert") {
      return handleConvertRoute(request, env.DB);
    }

    return new Response(
      request.method === "HEAD" ? null : getErrorHtml("Method Not Allowed"),
      { status: 405, headers: htmlHeaders },
    );
  },
};
