const { subjects, demoQuestions } = require("../data/catalog");
const { groupQuestionUnits } = require("./practice-session");

const objectiveTypes = new Set(["single_choice", "multiple_choice"]);

function normalizeOfficialQuestion(question) {
  const subject = subjects.find((item) => item.id === question.subjectId);
  const book = subject && subject.books.find((item) => item.id === question.bookId);
  const knowledgePoints = Array.isArray(question.knowledgePoints) ? question.knowledgePoints : [];
  const knowledgePoint = question.primaryKnowledgePoint || question.knowledgePoint || knowledgePoints[0] || "未归类知识点";
  const chapter = String(question.chapter || question.chapterId || "未归类章节");
  const source = question.source || [question.sourceLabel, question.sourcePage].filter(Boolean).join(" · ");
  const verifiedAnswerLabel = question.answerSource === "pdf_answer" ? "来源答案" : "平台核验答案";
  return {
    ...question,
    chapter,
    chapterId: question.chapterId || chapter,
    sectionId: question.sectionId || knowledgePoint,
    knowledgePoint,
    knowledgePoints: knowledgePoints.length ? knowledgePoints : [knowledgePoint],
    score: Number(question.score ?? question.maxScore) || 1,
    maxScore: Number(question.maxScore ?? question.score) || 1,
    source,
    verifiedAnswerLabel,
    breadcrumb: question.breadcrumb || [
      subject && subject.name,
      book && `${book.title}${book.volume ? ` · ${book.volume}` : ""}`,
      chapter,
    ].filter(Boolean).join(" · "),
    answerMode: question.answerMode || (objectiveTypes.has(question.type) ? "choice" : "text"),
    answerPlaceholder: question.answerPlaceholder || "请依据教材作答，可分点说明……",
    answerMaxLength: Number(question.answerMaxLength) || 2000,
    options: Array.isArray(question.options) ? question.options : [],
    correctAnswer: Array.isArray(question.correctAnswer) ? question.correctAnswer : [],
    scoringPoints: Array.isArray(question.scoringPoints) ? question.scoringPoints : [],
    answerVariants: question.answerVariants || {
      official: ["pdf_answer", "team_verified"].includes(question.answerSource) ? question.referenceAnswer : "",
      ai: question.answerSource === "ai_supplement" ? question.referenceAnswer : "",
      community: question.answerSource === "community_consensus" ? question.referenceAnswer : "",
    },
    hiddenAnswerVariants: Array.isArray(question.hiddenAnswerVariants) ? question.hiddenAnswerVariants : [],
    responseMode: question.responseMode === "annotation" ? "annotation" : "text",
    annotationText: String(question.annotationText || ""),
  };
}

function normalizeOfficialQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map(normalizeOfficialQuestion);
}

function catalogWithQuestionCounts(catalogSubjects, questions, explicitBookCounts = null) {
  const normalizedQuestions = normalizeOfficialQuestions(questions);
  const bookCounts = explicitBookCounts && typeof explicitBookCounts === "object"
    ? explicitBookCounts
    : groupQuestionUnits(normalizedQuestions).reduce((counts, unit) => {
      const question = unit.questions[0];
      if (!question) return counts;
      counts[question.bookId] = (counts[question.bookId] || 0) + 1;
      return counts;
    }, {});
  return (Array.isArray(catalogSubjects) ? catalogSubjects : []).map((subject) => ({
    ...subject,
    books: subject.books.map((book) => ({ ...book, questionCount: bookCounts[book.id] || 0 })),
    questionCount: subject.books.reduce((total, book) => total + (bookCounts[book.id] || 0), 0),
  }));
}

function fallbackOfficialQuestions() {
  return normalizeOfficialQuestions(demoQuestions);
}

module.exports = {
  catalogWithQuestionCounts,
  fallbackOfficialQuestions,
  normalizeOfficialQuestion,
  normalizeOfficialQuestions,
};
