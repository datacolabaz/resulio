import type { Entry } from "../types";

/** "Yeniliklər" (shared/whatsNew.ts): sidebar badge, home-page cards, landing section. Tuple order: [az, en, ru]. */
export const whatsNew = {
  "whatsNew.badge": ["Yeni", "New", "Новое"],
  "whatsNew.menuHasNew": ["Menyuda yeniliklər var", "There is something new in the menu", "В меню есть новое"],
  "whatsNew.title": ["Yeniliklər", "What's new", "Что нового"],
  "whatsNew.lead": ["Son günlərdə əlavə olundu — bir kliklə sına.", "Just added — try it in one click.", "Только что добавлено — попробуйте в один клик."],
  "whatsNew.cta.try": ["Sına", "Try it", "Попробовать"],
  "whatsNew.cta.view": ["Bax", "Take a look", "Посмотреть"],
  "whatsNew.dismiss": ["Bağla", "Dismiss", "Скрыть"],
  "whatsNew.dismissAria": ["“{title}” kartını bağla", "Dismiss “{title}”", "Скрыть «{title}»"],
  "whatsNew.dismissAll": ["Hamısını gördüm", "Seen them all", "Всё посмотрел(а)"],
  "whatsNew.audience.student": ["Şagirdlər üçün", "For students", "Для учеников"],
  "whatsNew.audience.teacher": ["Müəllimlər üçün", "For teachers", "Для учителей"],
  "whatsNew.premium": ["Premium", "Premium", "Премиум"],

  "whatsNew.landing.eyebrow": ["Yeniliklər", "What's new", "Что нового"],
  "whatsNew.landing.title": ["Resulio-da yeni nə var", "New in Resulio", "Что нового в Resulio"],
  "whatsNew.landing.lead": [
    "Şagirdlər üçün AI köməkçi və şəxsi təkrar planı, müəllimlər üçün risk radarı, təsdiqlə qoşulma və Claude ilə iş — hamısı bir platformada.",
    "An AI study coach and a personal review plan for students; a risk radar, approval-based joining and working through Claude for teachers — all in one platform.",
    "ИИ-помощник и личный план повторения для учеников; радар рисков, вступление с одобрением и работа через Claude для учителей — всё на одной платформе.",
  ],

  "whatsNew.study-coach.title": ["AI köməkçi", "AI study coach", "ИИ-помощник"],
  "whatsNew.study-coach.body": [
    "Materialını yüklə — konspekt və test dərhal hazır. Sualını ver, cavabı səhifə istinadı ilə al.",
    "Upload your material and get a summary and a quiz right away. Ask a question and get the answer with page references.",
    "Загрузите материал — конспект и тест готовы сразу. Задайте вопрос и получите ответ со ссылками на страницы.",
  ],
  "whatsNew.study-coach.landing": [
    "AI köməkçi: şagird PDF, DOCX, PPTX, mətn və ya şəkil yükləyir — material mövzulara bölünür, qısa konspekt və əsas anlayışlar hazırlanır, «Özünü yoxla» testləri səhvləri izah edir, AI müəllim isə materiala əsaslanıb səhifə istinadı ilə cavab verir.",
    "AI study coach: students upload a PDF, DOCX, PPTX, text or a photo — it is split into topics with a short summary and key concepts, self-check quizzes explain mistakes, and the AI tutor answers from the material with page references.",
    "ИИ-помощник: ученик загружает PDF, DOCX, PPTX, текст или фото — материал делится на темы с конспектом и ключевыми понятиями, тесты «Проверь себя» объясняют ошибки, а ИИ-репетитор отвечает по материалу со ссылками на страницы.",
  ],
  "whatsNew.study-coach.point1": [
    "PDF və ya şəkil yüklə — mövzular, konspekt və əsas anlayışlar avtomatik",
    "Upload a PDF or a photo — topics, summary and key concepts, automatically",
    "Загрузите PDF или фото — темы, конспект и понятия автоматически",
  ],
  "whatsNew.study-coach.point2": [
    "«Özünü yoxla»: 10 sual, səhvlərin izahı və təkrar vaxtı",
    "“Check yourself”: 10 questions, mistakes explained, a time to review",
    "«Проверь себя»: 10 вопросов, разбор ошибок и время повторения",
  ],
  "whatsNew.study-coach.point3": [
    "AI müəllim materialına əsasən cavab verir və səhifəni göstərir",
    "The AI tutor answers from your material and shows the page",
    "ИИ-репетитор отвечает по вашему материалу и показывает страницу",
  ],

  "whatsNew.growth-plan.title": ["Mövzu xəritəm", "My topic map", "Моя карта тем"],
  "whatsNew.growth-plan.body": [
    "Zəif mövzularını gör, gündəlik təkrar planı ilə irəlilə və XP topla.",
    "See your weak topics, move forward with a daily review plan and earn XP.",
    "Смотрите слабые темы, идите по ежедневному плану повторения и получайте XP.",
  ],
  "whatsNew.growth-plan.landing": [
    "Mövzu xəritəsi: şagird hansı mövzunun prioritet olduğunu görür, imtahana qədər gündəlik təkrar planı alır, müəllim icazə verdikdə 10 suallıq məşq testləri həll edir, XP və ardıcıl günlər seriyası ilə motivasiyasını qoruyur.",
    "Topic map: students see which topics are a priority, get a daily review plan up to the exam, take 10-question practice tests when the teacher allows it, and stay motivated with XP and a day streak.",
    "Карта тем: ученик видит приоритетные темы, получает ежедневный план повторения до экзамена, решает тренировочные тесты из 10 вопросов, если учитель разрешил, и сохраняет мотивацию с XP и серией дней.",
  ],
  "whatsNew.growth-plan.point1": [
    "Mövzu xəritəsi: güclü, təkrar tələb edən və «Prioritet mövzu»",
    "Topic map: strong, needs review and “Priority topic”",
    "Карта тем: сильные, на повторение и «Приоритетная тема»",
  ],
  "whatsNew.growth-plan.point2": [
    "İmtahana qədər gündəlik təkrar planı və məşq testləri",
    "A daily review plan up to the exam, with practice tests",
    "Ежедневный план повторения до экзамена и тренировочные тесты",
  ],
  "whatsNew.growth-plan.point3": [
    "XP, səviyyə və ardıcıl günlər — reytinq yoxdur, yalnız öz irəliləyişin",
    "XP, levels and streaks — no leaderboard, only your own progress",
    "XP, уровни и серии дней — без рейтинга, только ваш прогресс",
  ],

  "whatsNew.risk-radar.title": ["İnkişaf radarı", "Growth radar", "Радар роста"],
  "whatsNew.risk-radar.body": [
    "Riskdə olan şagirdləri səbəbi ilə gör, qrupun zəif mövzular xəritəsinə bax.",
    "See students at risk with the reasons, and your group's weak-topic map.",
    "Ученики в зоне риска с причинами и карта слабых тем группы.",
  ],
  "whatsNew.risk-radar.landing": [
    "İnkişaf radarı (Risk Radar): müəllim balı düşən, səhvləri təkrarlanan və ya imtahanı buraxan şagirdləri səbəbi ilə görür, qrupun zəif mövzular xəritəsinə baxır və razılıqla valideynə hesabat linki paylaşır.",
    "Growth radar (Risk Radar): teachers see students whose scores drop, who repeat mistakes or miss exams — with the reasons — view the group's weak-topic map and, with consent, share a report link with parents.",
    "Радар роста (Risk Radar): учитель видит учеников, у которых падают баллы, повторяются ошибки или пропущены экзамены, — с причинами, смотрит карту слабых тем группы и с согласия делится отчётом с родителями.",
  ],
  "whatsNew.risk-radar.point1": [
    "Risk radarı: hər şagird üçün səbəb — bal düşüşü, təkrar səhvlər, buraxılan imtahan",
    "Risk radar with reasons: score drop, repeated mistakes, missed exams",
    "Радар рисков с причинами: падение баллов, повторные ошибки, пропуски",
  ],
  "whatsNew.risk-radar.point2": [
    "Qrupun zəif mövzular xəritəsi və «kritik zəiflik» işarəsi",
    "The group's weak-topic map with a “critical weakness” label",
    "Карта слабых тем группы с отметкой «критическая слабость»",
  ],
  "whatsNew.risk-radar.point3": [
    "Gündəlik xülasə və valideyn üçün hesabat linki",
    "A daily digest and a report link for parents",
    "Ежедневная сводка и ссылка на отчёт для родителей",
  ],

  "whatsNew.coach-shares.title": ["Şagirdlərin paylaşdıqları", "Shared by students", "Присланное учениками"],
  "whatsNew.coach-shares.body": [
    "Şagirdlər AI köməkçidəki materiallarını və konspektlərini sizinlə paylaşır — hamısı burada.",
    "Students share their study-coach materials and summaries with you — find them here.",
    "Ученики делятся с вами материалами и конспектами из ИИ-помощника — они здесь.",
  ],

  "whatsNew.topic-summary.title": ["AI konspekt", "AI summary", "AI конспект"],
  "whatsNew.topic-summary.body": [
    "Bölmənin suallarından AI konspekt hazırla, redaktə et və qrupa material kimi göndər.",
    "Draft an AI summary from a section's questions, edit it, and send it to a group as a material.",
    "Создайте AI-конспект по вопросам раздела, отредактируйте и отправьте группе как материал.",
  ],

  "whatsNew.group-approval.title": ["Müəllim təsdiqi ilə qoşulma", "Join with teacher approval", "Вступление с одобрением учителя"],
  "whatsNew.group-approval.body": [
    "Qrup linki ilə gələnlər siz təsdiqləyənə qədər gözləyir, tanıdığınız şagirdlər isə dərhal qoşulur.",
    "People who use the group link wait for your approval; students you already know join at once.",
    "Пришедшие по ссылке группы ждут вашего одобрения, а знакомые ученики вступают сразу.",
  ],
  "whatsNew.group-approval.landing": [
    "Təsdiqlə qoşulma: qrup kodu və ya linki ilə gələn şagird müəllimin təsdiqini gözləyir, artıq tanınan şagirdlər dərhal daxil olur, birdəfəlik link və e-poçt dəvəti ilə gələnlər isə avtomatik qəbul edilir.",
    "Approval-based joining: a student who uses the group code or link waits for the teacher's approval, students the teacher already knows join at once, and single-use links and e-mail invites admit automatically.",
    "Вступление с одобрением: ученик, пришедший по коду или ссылке группы, ждёт одобрения учителя, знакомые ученики вступают сразу, а одноразовые ссылки и приглашения по e-mail принимаются автоматически.",
  ],
  "whatsNew.group-approval.point1": [
    "Hər qrup üçün seçim: avtomatik, təsdiqlə və ya yalnız dəvətlə",
    "Per group: automatic, with approval, or by invitation only",
    "Для каждой группы: автоматически, с одобрением или только по приглашению",
  ],
  "whatsNew.group-approval.point2": [
    "Gözləyən sorğular bir yerdə — bir kliklə təsdiq və ya imtina",
    "Pending requests in one place — approve or decline in one click",
    "Заявки в одном месте — одобрить или отклонить в один клик",
  ],
  "whatsNew.group-approval.point3": [
    "Tanıdığınız şagirdlər gözləmədən qoşulur",
    "Students you already know join without waiting",
    "Знакомые ученики вступают без ожидания",
  ],

  "whatsNew.claude-connector.title": ["Claude inteqrasiyası", "Claude integration", "Интеграция с Claude"],
  "whatsNew.claude-connector.body": [
    "Claude-a yazın: imtahan yaratsın, qrupa göndərsin, nəticələri göstərsin. Hər göndərmə sizin təsdiqinizlə.",
    "Ask Claude to create an exam, send it to a group and show the results. Every send needs your confirmation.",
    "Попросите Claude создать экзамен, отправить его группе и показать результаты. Каждая отправка — с вашего подтверждения.",
  ],
  "whatsNew.claude-connector.landing": [
    "Claude ilə inteqrasiya (premium): müəllim Claude-a sadə dillə yazır — Resulio-da imtahan qaralaması yaranır, təsdiqdən sonra qrupa və ya şagirdlərə göndərilir, nəticələr söhbətdə görünür. Qoşulma OAuth ilədir və Claude heç nəyi silə bilməz.",
    "Claude integration (premium): teachers write to Claude in plain language — a draft exam is created in Resulio, sent to groups or students after confirmation, and results appear in the chat. Connection uses OAuth and Claude cannot delete anything.",
    "Интеграция с Claude (премиум): учитель пишет Claude обычным языком — в Resulio создаётся черновик экзамена, после подтверждения он отправляется группам или ученикам, а результаты видны в чате. Подключение через OAuth, Claude ничего не может удалять.",
  ],
  "whatsNew.claude-connector.point1": [
    "«10 suallıq test hazırla» — qaralama Resulio-da yaranır",
    "“Make a 10-question test” — the draft appears in Resulio",
    "«Сделай тест из 10 вопросов» — черновик появится в Resulio",
  ],
  "whatsNew.claude-connector.point2": [
    "Qruplara və şagirdlərə göndərmə yalnız sizin təsdiqinizlə",
    "Sending to groups and students only with your confirmation",
    "Отправка группам и ученикам только с вашего подтверждения",
  ],
  "whatsNew.claude-connector.point3": [
    "Təhlükəsiz OAuth qoşulması; Claude heç nəyi silə bilməz",
    "Secure OAuth connection; Claude cannot delete anything",
    "Безопасное подключение по OAuth; Claude ничего не удаляет",
  ],
} as const satisfies Record<string, Entry>;
