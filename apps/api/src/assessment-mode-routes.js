function createAssessmentModeRoutes({ service, sendJson, readJsonBody, actor, logOperation, suggest }) {
  const base = "/api/admin/knowledge-classification/assessment-modes";
  return async (request, response, url) => {
    const standard = url.pathname.match(/^\/api\/admin\/knowledge-classification\/assessment-modes\/([^/]+)(\/impact)?$/);
    const assignment = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)\/assessment-modes(\/suggest)?$/);
    if (url.pathname !== base && !standard && !assignment) return false;
    try {
      let result;
      if (request.method === "GET" && url.pathname === base) {
        result = { items: service.list(Object.fromEntries(url.searchParams)) };
      } else if (request.method === "GET" && standard?.[2]) {
        result = { items: service.affected(decodeURIComponent(standard[1])) };
      } else if ((request.method === "POST" && url.pathname === base)
        || (request.method === "PATCH" && standard && !standard[2])) {
        result = service.saveStandard(standard ? decodeURIComponent(standard[1]) : "", await readJsonBody(request, 64 * 1024), actor());
        logOperation({ action: "assessment_mode.standard_save", category: "question", targetType: "assessment_mode",
          targetId: result.mode.id, summary: `保存考法标准：${result.mode.name}`,
          metadata: { version: result.mode.version, status: result.mode.status, affectedCount: result.affected.length } });
      } else if (assignment) {
        const id = decodeURIComponent(assignment[1]);
        if (request.method === "GET" && !assignment[2]) result = service.get(id);
        else if (request.method === "PUT" && !assignment[2]) {
          result = service.confirm(id, await readJsonBody(request, 16 * 1024), actor());
          logOperation({ action: "assessment_mode.question_confirm", category: "question", targetType: "question",
            targetId: id, summary: "人工确认题目考法", metadata: { revision: result.assignment.revision, modes: result.assignment.modes } });
        } else if (request.method === "POST" && assignment[2]) {
          const context = service.suggestionContext(id);
          result = await suggest(context);
        }
      }
      if (!result) sendJson(response, 405, { success: false, error: "method_not_allowed" });
      else sendJson(response, 200, { success: true, ...result });
    } catch (error) {
      sendJson(response, error.statusCode || 422, { success: false, error: error.message });
    }
    return true;
  };
}

module.exports = { createAssessmentModeRoutes };
