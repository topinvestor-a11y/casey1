import { handleBootstrap } from "./api/bootstrap.js";
import { handleListRequests, handleCreateRequest } from "./api/requests.js";
import { handleRespond, handleCancel } from "./api/requestActions.js";
import { handleGenerateNextWeek } from "./api/generateNextWeek.js";
import { handleReplaceEmployee } from "./api/admin.js";

// Simple manual router. Cloudflare recommends this unified Worker +
// static-assets shape for new projects in 2026 — one entry point that
// serves the built frontend (env.ASSETS) and handles /api/* itself,
// instead of the older split Pages+Functions model.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (pathname === "/api/bootstrap" && method === "GET") {
        return await handleBootstrap(env);
      }

      if (pathname === "/api/requests" && method === "GET") {
        return await handleListRequests(env);
      }
      if (pathname === "/api/requests" && method === "POST") {
        return await handleCreateRequest(request, env);
      }

      const respondMatch = pathname.match(/^\/api\/requests\/([^/]+)\/respond$/);
      if (respondMatch && method === "POST") {
        return await handleRespond(respondMatch[1], request, env);
      }

      const cancelMatch = pathname.match(/^\/api\/requests\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        return await handleCancel(cancelMatch[1], env);
      }

      if (pathname === "/api/shifts/generate-next-week" && method === "POST") {
        return await handleGenerateNextWeek(env);
      }

      if (pathname === "/api/admin/replace-employee" && method === "POST") {
        return await handleReplaceEmployee(request, env);
      }

      if (pathname.startsWith("/api/")) {
        return Response.json({ error: "요청한 API를 찾을 수 없어요." }, { status: 404 });
      }
    } catch (err) {
      return Response.json({ error: err.message || "서버 오류가 발생했어요." }, { status: 500 });
    }

    // Everything else: serve the built frontend (dist/) via the assets binding.
    return env.ASSETS.fetch(request);
  },
};
