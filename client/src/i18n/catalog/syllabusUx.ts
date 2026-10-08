import type { Entry } from "../types";

/** Syllabus onboarding hints, cross-links from existing screens and change badges. Tuple order: [az, en, ru]. */
export const syllabusUx = {
  "ux.teacherSteps.title": ["İş axını", "Workflow", "Порядок работы"],
  "ux.teacherSteps.label": ["Syllabus üzərində iş addımları", "Syllabus workflow steps", "Шаги работы над силлабусом"],
  "ux.tstep.create": ["Yarat", "Create", "Создать"],
  "ux.tstep.organize": ["Modul və dərslər", "Modules and lessons", "Модули и уроки"],
  "ux.tstep.teach": ["Məzmun", "Content", "Содержимое"],
  "ux.tstep.assign": ["Tələbələrə aç", "Open to students", "Открыть студентам"],
  "ux.tstep.assess": ["Qiymətləndir", "Grade", "Проверить"],
  "ux.tstep.track": ["İzlə", "Track", "Отслеживать"],
  "ux.thint.create": ["Ad, fənn və səviyyə", "Title, subject and level", "Название, предмет и уровень"],
  "ux.thint.organize": ["Modul və dərslər əlavə edin", "Add modules and lessons", "Добавьте модули и уроки"],
  "ux.thint.teach": ["Dərslərə material əlavə edin", "Add materials to lessons", "Добавьте материалы в уроки"],
  "ux.thint.assign": ["Dərc edin və qrupları seçin", "Publish and choose groups", "Опубликуйте и выберите группы"],
  "ux.thint.assess": ["Tapşırıq və testləri yoxlayın", "Check tasks and tests", "Проверяйте задания и тесты"],
  "ux.thint.assessSkipped": ["Yoxlanacaq tapşırıq yoxdur", "Nothing to grade here", "Проверять нечего"],
  "ux.thint.track": ["Tələbələrin irəliləyişinə baxın", "See students' progress", "Смотрите прогресс студентов"],
  "ux.state.done": ["tamamlanıb", "done", "готово"],
  "ux.state.current": ["növbəti addım", "next step", "следующий шаг"],
  "ux.state.todo": ["sonra", "later", "позже"],
  "ux.state.skipped": ["lazım deyil", "not needed", "не требуется"],

  "ux.studentSteps.title": ["Necə işləyir", "How it works", "Как это работает"],
  "ux.studentSteps.label": ["Öyrənmə addımları", "Learning steps", "Шаги обучения"],
  "ux.studentSteps.hide": ["Gizlət", "Hide", "Скрыть"],
  "ux.sstep.learn": ["Öyrən", "Learn", "Изучай"],
  "ux.sstep.practice": ["Məşq et", "Practice", "Практикуйся"],
  "ux.sstep.submit": ["Təhvil ver", "Submit", "Сдавай"],
  "ux.sstep.pass": ["Keç", "Pass", "Проходи"],
  "ux.sstep.unlock": ["Aç", "Unlock", "Открывай"],
  "ux.sstep.progress": ["İrəlilə", "Progress", "Продвигайся"],
  "ux.shint.learn": ["Nəzəriyyəni oxuyun", "Read the theory", "Прочитайте теорию"],
  "ux.shint.practice": ["Nümunələri müəllimlə keçin", "Work through the examples", "Разберите примеры"],
  "ux.shint.submit": ["Tapşırığınızı göndərin", "Send your practice task", "Отправьте своё задание"],
  "ux.shint.pass": ["Qiymətləndirmədən keçin", "Pass the assessment", "Пройдите оценивание"],
  "ux.shint.unlock": ["Növbəti dərs açılır", "The next lesson opens", "Открывается следующий урок"],
  "ux.shint.progress": ["Kursu sona çatdırın", "Finish the course", "Завершите курс"],

  "ux.continue.title": ["Öyrənməyə davam et", "Continue learning", "Продолжить обучение"],
  "ux.continue.all": ["Bütün syllabus-lar", "All syllabi", "Все силлабусы"],
  "ux.continue.more": ["Digər aktiv kurslar", "Other active courses", "Другие активные курсы"],

  "ux.home.title": ["Syllabus-lar", "Syllabi", "Силлабусы"],
  "ux.home.empty": [
    "Kursu modul və dərslərlə qurun, sonra qrupa açın.",
    "Build a course from modules and lessons, then open it to a group.",
    "Соберите курс из модулей и уроков и откройте его группе.",
  ],
  "ux.home.create": ["Syllabus yarat", "Create a syllabus", "Создать силлабус"],

  "ux.group.title": ["Syllabus-lar", "Syllabi", "Силлабусы"],
  "ux.group.empty": [
    "Bu qrupa hələ syllabus açılmayıb. Syllabus-un «Giriş» bölməsindən qrupu əlavə edin.",
    "No syllabus is open to this group yet. Add the group in a syllabus's Access tab.",
    "Этой группе пока не открыт ни один силлабус. Добавьте группу на вкладке «Доступ» силлабуса.",
  ],
  "ux.group.started": ["Başlayıb: {enrolled} / {members}", "Started: {enrolled} / {members}", "Начали: {enrolled} / {members}"],
  "ux.group.completed": ["Bitirib: {count}", "Finished: {count}", "Завершили: {count}"],
  "ux.group.until": ["{at} tarixinədək", "Until {at}", "До {at}"],
  "ux.group.archived": ["Arxivdə", "Archived", "В архиве"],
  "ux.group.open": ["Syllabus-a keç", "Open syllabus", "Открыть силлабус"],

  "ux.change.NEW": ["Yeni", "New", "Новый"],
  "ux.change.UPDATED": ["Yenilənib", "Updated", "Обновлён"],
  "ux.change.note": [
    "Müəllim kursu yeniləyib. «Yeni» və «Yenilənib» işarəli dərslərə baxın — irəliləyişiniz saxlanılıb.",
    "Your teacher updated this course. Check the lessons marked New or Updated — your progress is kept.",
    "Преподаватель обновил курс. Посмотрите уроки с отметками «Новый» и «Обновлён» — ваш прогресс сохранён.",
  ],

  "ux.usedIn": [
    "{count} syllabus-da istifadə olunur",
    "Used in {count} {count|syllabus|syllabi}",
    "Используется в {count} {count|силлабусе|силлабусах|силлабусах}",
  ],
} as const satisfies Record<string, Entry>;
