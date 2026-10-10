import type { Entry } from "../types";

/** Growth Engine: topic mapping, weakness map, risk radar, review plan and XP (docs/GROWTH-ENGINE.md). */
export const growth = {
  "nav.growth": ["İnkişaf radarı", "Growth radar", "Радар роста"],
  "error.GROWTH_NOT_AVAILABLE": ["Bu bölmə hesabınız üçün hələ aktiv deyil.", "This section is not enabled for your account yet.", "Этот раздел пока не включён для вашего аккаунта."],
  "error.GROWTH_DB_NOT_READY": ["Məlumat bazası yenilənir. Bir neçə dəqiqədən sonra yenidən cəhd edin.", "The database is being updated. Try again in a few minutes.", "База данных обновляется. Повторите попытку через несколько минут."],

  "growth.tab.topics": ["Mövzu bağlantıları", "Topic mapping", "Привязка тем"],
  "growth.recompute": ["Yenidən hesabla", "Recalculate", "Пересчитать"],
  "growth.recomputeQueued": ["{count} tələbə yenidən hesablanma növbəsinə əlavə olundu.", "{count} students were queued for recalculation.", "Студентов в очереди на пересчёт: {count}."],
  "growth.topics.intro": [
    "Nəticələrdə sərbəst yazılmış mövzuları sual bankının bölmələrinə bağlayın. Belə olduqda eyni mövzu bir yerdə hesablanır və bölmənin adı dəyişsə də tarixçə itmir.",
    "Map free-text topics from results to question bank sections. The same topic is then counted in one place, and history survives section renames.",
    "Привяжите темы, введённые вручную, к разделам банка вопросов. Тогда одна тема считается в одном месте, и история сохраняется при переименовании раздела.",
  ],
  "growth.topics.onSections": ["Bölmələrə bağlı cavablar", "Answers on bank sections", "Ответы по разделам банка"],
  "growth.topics.free": ["Sərbəst mövzulu cavablar", "Answers on free-text topics", "Ответы по темам без раздела"],
  "growth.topics.untagged": ["Mövzusuz cavablar", "Answers without a topic", "Ответы без темы"],
  "growth.topics.untaggedHint": [
    "Mövzusu olmayan suallar zəiflik xəritəsinə və risk hesablamalarına daxil edilmir. Suallara mövzu təyin etmək üçün onları sual bankında bölməyə köçürün.",
    "Questions without a topic are left out of the weakness map and risk signals. File them into a question bank section to give them a topic.",
    "Вопросы без темы не учитываются в карте слабых мест и сигналах риска. Перенесите их в раздел банка вопросов, чтобы задать тему.",
  ],
  "growth.topics.colTopic": ["Mövzu (nəticələrdə)", "Topic (in results)", "Тема (в результатах)"],
  "growth.topics.colAnswers": ["Cavab sayı", "Answers", "Ответов"],
  "growth.topics.colStudents": ["Tələbə", "Students", "Студентов"],
  "growth.topics.colSection": ["Bank bölməsi", "Bank section", "Раздел банка"],
  "growth.topics.colLabel": ["Görünən ad", "Display name", "Отображаемое имя"],
  "growth.topics.noSection": ["Bölməyə bağlanmayıb", "Not mapped to a section", "Не привязано к разделу"],
  "growth.topics.save": ["Yadda saxla", "Save", "Сохранить"],
  "growth.topics.saved": ["Bağlantı saxlanıldı. Nəticələr yenidən hesablanır.", "Mapping saved. Results are being recalculated.", "Привязка сохранена. Результаты пересчитываются."],
  "growth.topics.remove": ["Bağlantını sil", "Remove mapping", "Удалить привязку"],
  "growth.topics.aliases": ["Saxlanmış bağlantılar", "Saved mappings", "Сохранённые привязки"],
  "growth.topics.mapped": ["Bağlanıb", "Mapped", "Привязано"],
  "growth.topics.empty": ["Bütün mövzular sual bankının bölmələrinə bağlıdır.", "Every topic is on a question bank section.", "Все темы привязаны к разделам банка вопросов."],
  "growth.topics.noData": ["Hələ hesablanmış nəticə yoxdur. İlk imtahan nəticələrindən sonra burada görünəcək.", "No results have been processed yet. They will appear here after the first exam results.", "Обработанных результатов пока нет. Они появятся после первых результатов экзаменов."],
} as const satisfies Record<string, Entry>;
