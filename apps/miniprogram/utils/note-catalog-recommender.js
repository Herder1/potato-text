const { subjects } = require("../data/catalog");
const { createCatalogSelection } = require("./asset-catalog");

const SUBJECT_HINTS = {
  "modern-chinese": ["现代汉语", "普通话", "语音", "声母", "韵母", "声调", "汉字", "词汇", "语法", "修辞", "短语", "复句", "结构助词", "动态助词", "语气词", "的地得"],
  "classical-chinese": ["古代汉语", "通假字", "古今字", "词类活用", "宾语前置", "古文翻译", "古文断句", "文言虚词"],
  "ancient-literature": ["中国古代文学", "诗经", "楚辞", "李白", "杜甫", "白居易", "韩愈", "柳宗元", "苏轼", "红楼梦", "唐诗", "宋词"],
  "modern-literature": ["中国现代文学", "鲁迅", "郭沫若", "茅盾", "巴金", "老舍", "曹禺", "新文学", "左翼文学"],
  "contemporary-literature": ["中国当代文学", "十七年文学", "伤痕文学", "反思文学", "寻根文学", "先锋文学", "新写实"],
};

const CHAPTER_HINTS = {
  "modern-chinese": {
    phonetics: ["语音", "辅音", "元音", "声母", "韵母", "声调", "音节", "音变", "轻声", "儿化"],
    characters: ["文字", "汉字", "字形", "笔画", "偏旁", "部件", "造字", "六书", "异体字", "繁简字"],
    vocabulary: ["词汇", "语素", "词义", "合成词", "单纯词", "熟语", "成语", "惯用语", "歇后语"],
    grammar: ["语法", "词类", "实词", "虚词", "名词", "动词", "形容词", "区别词", "数词", "量词", "副词", "代词", "介词", "连词", "助词", "结构助词", "动态助词", "比况助词", "语气词", "短语", "句法", "句型", "复句", "的地得"],
    rhetoric: ["修辞", "辞格", "比喻", "比拟", "借代", "夸张", "对偶", "排比", "反复", "双关", "设问", "反问"],
  },
  "classical-chinese": {
    characters: ["古文字", "汉字结构", "古今字", "异体字", "通假字"],
    vocabulary: ["古今词义", "本义", "引申义", "同义词辨析"],
    grammar: ["古代汉语语法", "词类活用", "宾语前置", "判断句", "被动句", "文言虚词"],
    phonology: ["音韵", "诗律", "词律", "平仄", "押韵"],
  },
  "ancient-literature": {
    "pre-qin": ["先秦", "上古神话", "诗经", "楚辞", "诸子散文", "历史散文"],
    "qin-han": ["秦汉", "汉赋", "史记", "汉书", "汉乐府"],
    "wei-jin": ["魏晋", "南北朝", "建安", "正始", "陶渊明", "南北朝民歌"],
    "sui-tang": ["隋唐", "唐代", "初唐", "盛唐", "中唐", "晚唐", "李白", "杜甫", "白居易", "韩愈", "柳宗元"],
    "song-yuan": ["宋代", "北宋", "南宋", "元代", "宋词", "苏轼", "辛弃疾", "关汉卿"],
    "ming-qing": ["明代", "清代", "明清", "红楼梦", "三国演义", "水浒传", "西游记", "聊斋志异"],
  },
};

function cleanLabel(value) {
  return String(value || "")
    .replace(/第[一二三四五六七八九十百0-9]+[编章节]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s·、，。；：:—\-《》“”"'（）()]/g, "")
    .trim();
}

function normalizedKeywords(values) {
  return [...new Set((values || []).map(cleanLabel).filter((item) => item.length >= 2))];
}

function matchedKeywords(text, values) {
  const normalizedText = cleanLabel(text);
  return normalizedKeywords(values).filter((keyword) => normalizedText.includes(keyword));
}

function scoreMatches(matches) {
  return matches.reduce((total, keyword) => total + 4 + Math.min(keyword.length, 8) * 2, 0);
}

function chapterAliases(subjectId, chapter) {
  const id = String(chapter && chapter.id || "");
  const title = cleanLabel(chapter && chapter.title);
  const subjectHints = CHAPTER_HINTS[subjectId] || {};
  const direct = subjectHints[id] || [];
  const byTitle = Object.entries(subjectHints).find(([key, aliases]) => id.includes(key)
    || aliases.some((alias) => cleanLabel(alias).length >= 2 && title.includes(cleanLabel(alias))));
  return [...direct, ...(byTitle ? byTitle[1] : [])];
}

function sectionAliases(subjectId, chapter, section) {
  const title = cleanLabel(section && section.title);
  if (subjectId === "modern-chinese") {
    if (/词类|实词|虚词/.test(title)) return ["词类", "实词", "虚词", "名词", "动词", "形容词", "区别词", "数词", "量词", "副词", "代词", "介词", "连词", "助词", "结构助词", "动态助词", "比况助词", "语气词", "的地得"];
    if (/短语/.test(title)) return ["短语", "联合短语", "偏正短语", "动宾短语", "主谓短语", "中补短语"];
    if (/句法|句型|句子/.test(title)) return ["句法", "句法成分", "主语", "谓语", "宾语", "定语", "状语", "补语", "句型", "句类"];
    if (/复句/.test(title)) return ["复句", "分句", "关联词", "联合复句", "偏正复句", "多重复句"];
  }
  return [];
}

function candidateEntries(items, forcedId) {
  if (!forcedId) return items;
  const exact = items.filter((item) => String(item.id) === String(forcedId));
  return exact.length ? exact : items;
}

function normalizeCatalogResolved(resolved = {}) {
  const section = resolved.section === true;
  const chapter = resolved.chapter === true || section;
  const book = resolved.book === true || chapter;
  const subject = resolved.subject === true || book;
  return { subject, book, chapter, section };
}

function recommendNoteCatalog(text, forced = {}, storage = wx) {
  let best = null;
  const forcedSubjectIndex = forced.subjectId ? subjects.findIndex((item) => item.id === forced.subjectId) : -1;
  const subjectEntries = forcedSubjectIndex >= 0
    ? [{ subject: subjects[forcedSubjectIndex], subjectIndex: forcedSubjectIndex }]
    : subjects.map((subject, subjectIndex) => ({ subject, subjectIndex }));

  subjectEntries.forEach(({ subject, subjectIndex }) => {
    const subjectMatches = matchedKeywords(text, [subject.name, ...(SUBJECT_HINTS[subject.id] || [])]);
    candidateEntries(subject.books || [], forced.bookId).forEach((book) => {
      const bookIndex = subject.books.findIndex((item) => item.id === book.id);
      const selection = createCatalogSelection(subjectIndex, bookIndex, storage);
      const bookMatches = matchedKeywords(text, [book.title, book.volume]);
      candidateEntries(selection.chapters || [], forced.chapterId).forEach((chapter) => {
        const chapterValues = [chapter.title, ...(chapter.knowledgePoints || []), ...chapterAliases(subject.id, chapter)];
        const chapterMatches = matchedKeywords(text, chapterValues);
        const sections = candidateEntries(chapter.sections || [], forced.sectionId);
        const sectionEntries = sections.length ? sections : [null];
        sectionEntries.forEach((section) => {
          const sectionValues = section
            ? [section.title, ...(section.knowledgePoints || []), ...sectionAliases(subject.id, chapter, section)]
            : [];
          const sectionMatches = matchedKeywords(text, sectionValues);
          const score = scoreMatches(subjectMatches) * 4
            + scoreMatches(bookMatches)
            + scoreMatches(chapterMatches) * 2
            + scoreMatches(sectionMatches) * 3
            + (forced.subjectId ? 400 : 0)
            + (forced.bookId ? 300 : 0)
            + (forced.chapterId ? 200 : 0)
            + (forced.sectionId ? 100 : 0);
          const candidate = {
            subjectIndex,
            bookIndex,
            chapters: selection.chapters,
            chapterIndex: selection.chapters.findIndex((item) => item.id === chapter.id),
            sections: chapter.sections || [],
            sectionIndex: section ? (chapter.sections || []).findIndex((item) => item.id === section.id) : 0,
            subjectMatches,
            bookMatches,
            chapterMatches,
            sectionMatches,
            score,
          };
          if (!best || candidate.score > best.score) best = candidate;
        });
      });
    });
  });

  if (!best) return null;
  const resolved = normalizeCatalogResolved({
    subject: !!forced.subjectId || best.subjectMatches.length > 0,
    book: !!forced.bookId || best.bookMatches.length > 0 || best.chapterMatches.length > 0 || best.sectionMatches.length > 0,
    chapter: !!forced.chapterId || best.chapterMatches.length > 0 || best.sectionMatches.length > 0,
    section: !!forced.sectionId || best.sectionMatches.length > 0,
  });
  const usefulMatches = [...new Set([...best.sectionMatches, ...best.chapterMatches, ...best.subjectMatches])]
    .filter((item) => !subjects.some((subject) => cleanLabel(subject.name) === item));
  return { ...best, resolved, usefulMatches };
}

module.exports = { cleanLabel, matchedKeywords, normalizeCatalogResolved, recommendNoteCatalog };
