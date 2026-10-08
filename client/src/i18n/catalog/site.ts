import type { Entry } from "../types";

/**
 * Public marketing pages (home extras, About, FAQ, landing pages), their meta tags, llms.txt and
 * JSON-LD. Every statement must be backed by the product itself — no invented facts, numbers or
 * customers. Tuple order: [az, en, ru].
 */
export const site = {
  // Meta (title ≤ ~60 chars, description ≤ ~160 chars)
  "site.meta.home.title": [
    "Resulio — müəllimlər üçün onlayn imtahan və qiymətləndirmə platforması",
    "Resulio — online exam and assessment platform for teachers",
    "Resulio — платформа онлайн-экзаменов и оценивания для учителей",
  ],
  "site.meta.home.description": [
    "Resulio onlayn imtahan və qiymətləndirmə platformasıdır: imtahan və tapşırıq yaradın, link və QR kodla paylaşın, nəticələri mövzu üzrə analiz edin. AZ / RU / EN.",
    "Resulio is an online exam and assessment platform: create exams and assignments, share them by link or QR code and analyse results by topic. AZ / RU / EN.",
    "Resulio — онлайн-платформа для экзаменов и оценивания: создавайте экзамены и задания, делитесь по ссылке или QR-коду, анализируйте результаты по темам.",
  ],
  "site.meta.about.title": ["Resulio haqqında — platforma və təsisçi", "About Resulio — the platform and its founder", "О Resulio — платформа и основатель"],
  "site.meta.about.description": [
    "Resulio nədir, kim üçündür və kim tərəfindən yaradılıb. Resulio-nun təsisçisi Telman Abdulla-dır. Rəsmi sayt: resulio.co.",
    "What Resulio is, who it is for and who built it. Resulio was founded by Telman Abdulla. Official website: resulio.co.",
    "Что такое Resulio, для кого он и кто его создал. Основатель Resulio — Тельман Абдулла. Официальный сайт: resulio.co.",
  ],
  "site.meta.faq.title": ["Resulio — tez-tez verilən suallar", "Resulio — frequently asked questions", "Resulio — частые вопросы"],
  "site.meta.faq.description": [
    "Resulio haqqında suallar və cavablar: sual tipləri, KSQ və BSQ, şagirdlərin qoşulması, vaxt nəzarəti, qiymətləndirmə, analitika, dillər və qiymət.",
    "Questions and answers about Resulio: question types, KSQ and BSQ, how students join, exam timing, grading, analytics, languages and pricing.",
    "Вопросы и ответы о Resulio: типы вопросов, KSQ и BSQ, подключение учеников, контроль времени, проверка, аналитика, языки и цена.",
  ],
  "site.meta.assessmentPlatform.title": [
    "Azərbaycan üçün onlayn qiymətləndirmə platforması — Resulio",
    "Online assessment platform for Azerbaijan — Resulio",
    "Платформа онлайн-оценивания для Азербайджана — Resulio",
  ],
  "site.meta.assessmentPlatform.description": [
    "Resulio Azərbaycan dilində işləyən, KSQ və BSQ formatlarını dəstəkləyən onlayn imtahan və qiymətləndirmə platformasıdır. Müəllimlər, mərkəzlər və məktəblər üçün.",
    "Resulio is an online exam and assessment platform in Azerbaijani, Russian and English that supports the KSQ and BSQ school formats. For teachers, centres and schools.",
    "Resulio — платформа онлайн-экзаменов на азербайджанском, русском и английском с поддержкой школьных форматов KSQ и BSQ. Для учителей, центров и школ.",
  ],
  "site.meta.forTeachers.title": ["Müəllimlər üçün Resulio — imtahan, qrup və analitika", "Resulio for teachers — exams, groups and analytics", "Resulio для учителей — экзамены, группы и аналитика"],
  "site.meta.forTeachers.description": [
    "Müəllimlər, təlimçilər və tədris mərkəzləri Resulio-da qrup yaradır, imtahan və tapşırıq paylaşır və nəticələrdən hansı mövzunun təkrar izaha ehtiyacı olduğunu görür.",
    "Teachers, trainers and learning centres use Resulio to create groups, share exams and assignments, and see from the results which topics need a second explanation.",
    "Учителя, тренеры и учебные центры создают в Resulio группы, делятся экзаменами и заданиями и видят по результатам, какие темы нужно объяснить ещё раз.",
  ],
  // Entity definition, reused on the home page, About, landing pages, llms.txt and JSON-LD.
  "site.definition": [
    "Resulio müəllimlər, təlimçilər, tədris mərkəzləri və məktəblər üçün onlayn imtahan və qiymətləndirmə platformasıdır. Müəllim imtahan yaradır, onu şagirdlərə link və ya QR kodla paylaşır və nəticələrdən hansı mövzuların təkrar izaha ehtiyac duyduğunu görür. İnterfeys Azərbaycan, rus və ingilis dillərindədir.",
    "Resulio is an online exam and assessment platform for teachers, trainers, learning centres and schools. A teacher creates an exam, shares it with students by link or QR code, and sees from the results which topics need a second explanation. The interface is available in Azerbaijani, Russian and English.",
    "Resulio — онлайн-платформа для экзаменов и оценивания для учителей, тренеров, учебных центров и школ. Учитель создаёт экзамен, делится им с учениками по ссылке или QR-коду и по результатам видит, какие темы нужно объяснить ещё раз. Интерфейс доступен на азербайджанском, русском и английском языках.",
  ],
  "site.definitionShort": [
    "Müəllimlər, mərkəzlər və məktəblər üçün onlayn imtahan və qiymətləndirmə platforması.",
    "Online exam and assessment platform for teachers, centres and schools.",
    "Платформа онлайн-экзаменов и оценивания для учителей, центров и школ.",
  ],

  // Navigation and footer
  "site.nav.home": ["Ana səhifə", "Home", "Главная"],
  "site.nav.about": ["Haqqında", "About", "О проекте"],
  "site.nav.faq": ["Suallar", "FAQ", "Вопросы"],
  "site.nav.assessmentPlatform": ["Azərbaycan üçün qiymətləndirmə platforması", "Assessment platform for Azerbaijan", "Платформа оценивания для Азербайджана"],
  "site.nav.forTeachers": ["Müəllimlər üçün", "For teachers", "Для учителей"],
  "site.nav.privacy": ["Məxfilik siyasəti", "Privacy policy", "Политика конфиденциальности"],
  "site.nav.public": ["Sayt naviqasiyası", "Site navigation", "Навигация по сайту"],
  "site.nav.start": ["Pulsuz başla", "Start for free", "Начать бесплатно"],
  "site.footer.founder": ["Təsisçi: Telman Abdulla", "Founder: Telman Abdulla", "Основатель: Тельман Абдулла"],
  "site.partners.title": ["Rəsmi tərəfdaşlar", "Official partners", "Официальные партнёры"],
  "site.partners.lead": ["Resulio-nun rəsmi tərəfdaşları.", "Resulio's official partners.", "Официальные партнёры Resulio."],
  "site.breadcrumb": ["Naviqasiya zənciri", "Breadcrumb", "Навигационная цепочка"],
  "site.related": ["Digər səhifələr", "More about Resulio", "Ещё о Resulio"],

  // Home: structured "at a glance" block, written to be quoted as-is by people and AI assistants.
  "site.glance.title": ["Resulio qısaca", "Resulio at a glance", "Resulio вкратце"],
  "site.glance.what": ["Nədir?", "What is it?", "Что это?"],
  "site.glance.who": ["Kim üçündür?", "Who is it for?", "Для кого?"],
  "site.glance.whoValue": [
    "Müəllimlər, təlimçilər, tədris mərkəzləri və məktəblər — və onların şagird və tələbələri.",
    "Teachers, trainers, learning centres and schools — and their students.",
    "Учителя, тренеры, учебные центры и школы — и их ученики.",
  ],
  "site.glance.does": ["Nə edir?", "What does it do?", "Что делает?"],
  "site.glance.doesValue": [
    "İmtahan yaratmaq, onu link və ya QR kodla paylaşmaq, vaxtı server tərəfində izləmək, qapalı sualları avtomatik yoxlamaq və nəticələri sual və mövzu üzrə analiz etmək.",
    "Create an exam, share it by link or QR code, track time on the server, grade closed questions automatically and analyse results by question and topic.",
    "Создать экзамен, поделиться им по ссылке или QR-коду, отслеживать время на сервере, автоматически проверять закрытые вопросы и анализировать результаты по вопросам и темам.",
  ],
  "site.glance.features": ["Əsas funksiyalar", "Key features", "Основные функции"],
  "site.glance.languages": ["Dillər", "Languages", "Языки"],
  "site.glance.languagesValue": ["Azərbaycan, rus və ingilis dili.", "Azerbaijani, Russian and English.", "Азербайджанский, русский и английский."],
  "site.glance.start": ["Necə başlamaq olar?", "How to start?", "Как начать?"],
  "site.glance.startValue": [
    "resulio.co saytında «Pulsuz başla» düyməsini basın. Beta müddətində bütün əsas funksiyalar pulsuzdur.",
    "Press “Start for free” on resulio.co. All core features are free during the beta.",
    "Нажмите «Начать бесплатно» на resulio.co. Во время беты все основные функции бесплатны.",
  ],
  "site.glance.website": ["Rəsmi sayt", "Official website", "Официальный сайт"],

  // Features (only what the product does today)
  "site.feature.questionTypes": [
    "9 sual tipi: tək seçim, çox seçim, doğru / yanlış, qısa cavab, açıq cavab (esse), uyğunlaşdırma, sıralama, boşluq doldurma və rəqəmli cavab.",
    "9 question types: single choice, multiple choice, true / false, short answer, open answer (essay), matching, ordering, fill in the blanks and numeric answer.",
    "9 типов вопросов: один ответ, несколько ответов, верно / неверно, краткий ответ, развёрнутый ответ (эссе), сопоставление, упорядочивание, заполнение пропусков и числовой ответ.",
  ],
  "site.feature.schoolFormats": [
    "Məktəb formatları: KSQ (kiçik summativ qiymətləndirmə) və BSQ (böyük summativ qiymətləndirmə), həmçinin adi imtahan.",
    "School formats: KSQ and BSQ (the small and large summative assessments used in Azerbaijani schools), plus regular exams.",
    "Школьные форматы: KSQ и BSQ (малое и большое суммативное оценивание в школах Азербайджана), а также обычные экзамены.",
  ],
  "site.feature.groups": [
    "Qruplar: dəvət kodu, dəvət linki və ya e-poçt ilə dəvət; linklə qoşulan şagird dərhal qrupa əlavə olunur.",
    "Groups: invite by code, link or email; students who join by link are added instantly.",
    "Группы: приглашение по коду, ссылке или эл. почте; вступившие по ссылке сразу попадают в группу.",
  ],
  "site.feature.sharing": [
    "İmtahanı seçilmiş qrupa və ya fərdi şagirdlərə link, QR kod, WhatsApp və Telegram ilə göndərmək.",
    "Send an exam to a chosen group or to individual students by link, QR code, WhatsApp or Telegram.",
    "Отправка экзамена группе или отдельным ученикам по ссылке, QR-коду, через WhatsApp или Telegram.",
  ],
  "site.feature.session": [
    "Vaxt server tərəfində izlənir, cavablar avtomatik yadda saxlanılır və vaxt bitəndə imtahan avtomatik təhvil verilir.",
    "Time is tracked on the server, answers are saved automatically and the exam is submitted on its own when time runs out.",
    "Время отслеживается на сервере, ответы сохраняются автоматически, а по истечении времени экзамен сдаётся сам.",
  ],
  "site.feature.grading": [
    "İmtahanlarda qapalı suallar avtomatik yoxlanılır; açıq (esse) cavabları müəllim qiymətləndirir.",
    "In exams, closed questions are graded automatically; open (essay) answers are graded by the teacher.",
    "В экзаменах закрытые вопросы проверяются автоматически; развёрнутые ответы (эссе) оценивает учитель.",
  ],
  "site.feature.aiGrading": [
    "Tapşırıqlar üçün AI ilkin yoxlama: AI işi müəllimin cavab açarı ilə müqayisə edir, bal və rəy təklif edir; aydın hallarda qiyməti avtomatik verir, şübhəli işləri müəllimə saxlayır. Cavab açarı yoxdursa, AI onu qaralama kimi hazırlayır — şagird açarı görmür.",
    "AI pre-grading for assignments: the AI compares the work with the teacher's answer key and suggests a score and feedback; clear cases can be graded automatically, doubtful ones wait for the teacher. If there is no answer key, the AI drafts one — students never see it.",
    "AI-предпроверка заданий: AI сравнивает работу с ключом ответов учителя и предлагает балл и отзыв; очевидные случаи оцениваются автоматически, сомнительные ждут учителя. Если ключа нет, AI готовит его черновик — ученики его не видят.",
  ],
  "site.feature.notifications": [
    "Bildirişlər: qiymət veriləndə və ya dəyişəndə şagird platformada, e-poçtla və push bildirişlə xəbər alır.",
    "Notifications: when a grade is released or changed, the student is notified in the app, by email and by push notification.",
    "Уведомления: когда оценка выставлена или изменена, ученик получает уведомление в приложении, по эл. почте и push-уведомлением.",
  ],
  "site.feature.analytics": [
    "Nəticə analitikası: median bal, ən çox səhv edilən suallar, mövzu üzrə nəticə və hər sual üzrə doğru, səhv və cavabsız payı.",
    "Results analytics: median score, most-missed questions, results by topic and the share of correct, wrong and unanswered for every question.",
    "Аналитика результатов: медианный балл, самые сложные вопросы, результат по темам и доля верных, неверных и пропущенных ответов по каждому вопросу.",
  ],
  "site.feature.tasks": [
    "Tapşırıq və tədris materiallarını qrupla və ya paylaşım linki ilə göndərmək; müəllim kimin açdığını, yüklədiyini və təhvil verdiyini görür.",
    "Send assignments and learning materials to a group or by share link; the teacher sees who opened, downloaded and submitted them.",
    "Задания и учебные материалы для группы или по ссылке; учитель видит, кто открыл, скачал и сдал.",
  ],
  "site.feature.ai": [
    "AI ilə sual qaralamaları yaratmaq (o cümlədən Azərbaycan dilində); müəllim onları yoxlayıb imtahana əlavə edir.",
    "Generate draft questions with AI (including in Azerbaijani); the teacher reviews them before adding them to an exam.",
    "Черновики вопросов с помощью AI (в том числе на азербайджанском); учитель проверяет их перед добавлением в экзамен.",
  ],
  "site.feature.languages": [
    "Azərbaycan, rus və ingilis dillərində interfeys; açıq və tünd rejim; kompüter, planşet və telefon brauzerində işləyir.",
    "Interface in Azerbaijani, Russian and English; light and dark mode; works in the browser on computers, tablets and phones.",
    "Интерфейс на азербайджанском, русском и английском; светлая и тёмная тема; работает в браузере на компьютере, планшете и телефоне.",
  ],

  // FAQ
  "site.faq.title": ["Tez-tez verilən suallar", "Frequently asked questions", "Частые вопросы"],
  "site.faq.lead": [
    "Resulio haqqında ən çox verilən suallar və qısa cavablar.",
    "The questions people ask most often about Resulio, with short answers.",
    "Самые частые вопросы о Resulio и короткие ответы на них.",
  ],
  "site.faq.all": ["Bütün suallar →", "All questions →", "Все вопросы →"],
  "site.faq.q.what": ["Resulio nədir?", "What is Resulio?", "Что такое Resulio?"],
  "site.faq.a.what": [
    "Resulio onlayn imtahan və qiymətləndirmə platformasıdır. Müəllim imtahan yaradır, onu şagirdlərə link və ya QR kodla paylaşır və nəticələrdən hansı sualların çətin olduğunu və hansı mövzuların təkrar izaha ehtiyac duyduğunu görür.",
    "Resulio is an online exam and assessment platform. A teacher creates an exam, shares it with students by link or QR code, and sees from the results which questions were hard and which topics need a second explanation.",
    "Resulio — онлайн-платформа для экзаменов и оценивания. Учитель создаёт экзамен, делится им с учениками по ссылке или QR-коду и по результатам видит, какие вопросы оказались сложными и какие темы нужно объяснить ещё раз.",
  ],
  "site.faq.q.who": ["Resulio kimlər üçündür?", "Who is Resulio for?", "Для кого Resulio?"],
  "site.faq.a.who": [
    "Müəllimlər, təlimçilər, tədris mərkəzləri və məktəblər üçün — həm məktəb dərsləri, həm də abituriyent, buraxılış və beynəlxalq imtahanlara (IELTS, TOEFL, SAT və s.) hazırlıq, dil, IT və peşə kursları üçün. Şagird və tələbələr müəllimin dəvəti ilə qoşulur. Bir hesabla həm öyrənmək, həm də tədris etmək olar.",
    "Teachers, trainers, learning centres and schools — for school lessons as well as university entrance, school-leaving and international exam prep (IELTS, TOEFL, SAT and others), language, IT and professional courses. Students join by their teacher's invitation. One account can be used both to learn and to teach.",
    "Учителям, тренерам, учебным центрам и школам — для школьных уроков, подготовки к вступительным, выпускным и международным экзаменам (IELTS, TOEFL, SAT и др.), языковых, IT- и профессиональных курсов. Ученики присоединяются по приглашению учителя. Один аккаунт подходит и для учёбы, и для преподавания.",
  ],
  "site.faq.q.azerbaijan": [
    "Azərbaycan üçün qiymətləndirmə platforması kimi Resulio uyğundurmu?",
    "Is Resulio suitable as an assessment platform for Azerbaijan?",
    "Подходит ли Resulio как платформа оценивания для Азербайджана?",
  ],
  "site.faq.a.azerbaijan": [
    "Bəli. Resulio-nun əsas dili Azərbaycan dilidir (rus və ingilis dili də var), məktəb formatları olan KSQ və BSQ dəstəklənir, AI ilə Azərbaycan dilində sual qaralamaları yaratmaq olar və imtahan cədvəlləri standart olaraq Bakı vaxtı ilə qurulur.",
    "Yes. Resulio's primary language is Azerbaijani (Russian and English are also available), it supports the KSQ and BSQ school formats, AI can draft questions in Azerbaijani, and exam schedules default to Baku time.",
    "Да. Основной язык Resulio — азербайджанский (также есть русский и английский), поддерживаются школьные форматы KSQ и BSQ, AI может готовить черновики вопросов на азербайджанском, а расписание экзаменов по умолчанию задаётся по бакинскому времени.",
  ],
  "site.faq.q.questionTypes": ["Resulio-da hansı sual tipləri var?", "Which question types does Resulio support?", "Какие типы вопросов есть в Resulio?"],
  "site.faq.a.questionTypes": [
    "9 sual tipi var: tək seçim, çox seçim, doğru / yanlış, qısa cavab, açıq cavab (esse), uyğunlaşdırma, sıralama, boşluq doldurma və rəqəmli cavab. İmtahanı paylaşmazdan əvvəl onu şagirdin görəcəyi formada yoxlamaq olar.",
    "There are 9 question types: single choice, multiple choice, true / false, short answer, open answer (essay), matching, ordering, fill in the blanks and numeric answer. You can preview the exam exactly as a student will see it before sharing it.",
    "Есть 9 типов вопросов: один ответ, несколько ответов, верно / неверно, краткий ответ, развёрнутый ответ (эссе), сопоставление, упорядочивание, заполнение пропусков и числовой ответ. Перед отправкой экзамен можно посмотреть так, как его увидит ученик.",
  ],
  "site.faq.q.join": ["Şagirdlər imtahana necə qoşulur?", "How do students join an exam?", "Как ученики попадают на экзамен?"],
  "site.faq.a.join": [
    "Müəllim şagirdləri qrupa dəvət kodu, dəvət linki, QR kod və ya e-poçt ilə dəvət edir. İmtahan seçilmiş qrupa və ya fərdi şagirdlərə təyin olunur və link, QR kod, WhatsApp və ya Telegram ilə paylaşılır.",
    "The teacher invites students to a group by invite code, invite link, QR code or email. The exam is assigned to a chosen group or to individual students and shared by link, QR code, WhatsApp or Telegram.",
    "Учитель приглашает учеников в группу по коду, ссылке, QR-коду или эл. почте. Экзамен назначается выбранной группе или отдельным ученикам и отправляется по ссылке, QR-коду, через WhatsApp или Telegram.",
  ],
  "site.faq.q.timing": ["İmtahan vaxtı necə idarə olunur?", "How is exam time controlled?", "Как контролируется время экзамена?"],
  "site.faq.a.timing": [
    "Vaxt şagirdin cihazında deyil, server tərəfində izlənir. Cavablar avtomatik yadda saxlanılır və vaxt bitəndə imtahan avtomatik təhvil verilir.",
    "Time is tracked on the server, not on the student's device. Answers are saved automatically, and the exam is submitted on its own when time runs out.",
    "Время отслеживается на сервере, а не на устройстве ученика. Ответы сохраняются автоматически, а по истечении времени экзамен сдаётся сам.",
  ],
  "site.faq.q.grading": ["Cavablar necə yoxlanılır?", "How are answers graded?", "Как проверяются ответы?"],
  "site.faq.a.grading": [
    "İmtahanlarda qapalı tipli suallar (məsələn, test, doğru / yanlış, rəqəmli cavab) avtomatik yoxlanılır, açıq (esse) cavabları müəllim qiymətləndirir. Tapşırıqlarda isə AI ilkin yoxlama müəllimə kömək edir.",
    "In exams, closed questions (such as choice, true / false and numeric answers) are graded automatically and open (essay) answers are graded by the teacher. For assignments, AI pre-grading helps the teacher.",
    "В экзаменах закрытые вопросы (например, с выбором ответа, верно / неверно, числовые) проверяются автоматически, развёрнутые ответы (эссе) оценивает учитель. В заданиях учителю помогает AI-предпроверка.",
  ],
  "site.faq.q.aiGrading": ["AI tapşırıqları necə yoxlayır?", "How does AI check assignments?", "Как AI проверяет задания?"],
  "site.faq.a.aiGrading": [
    "AI şagirdin işini müəllimin cavab açarı və tapşırığın şərti ilə müqayisə edir, bal (0–100) və rəy təklif edir. Aydın hallarda qiymət avtomatik verilir və şagird bildiriş alır; şübhəli işlər müəllimin yoxlamasına qalır. Müəllim istənilən qiyməti dəyişə bilər. Cavab açarı yoxdursa, AI onu qaralama kimi hazırlayır və şagird bu açarı görmür.",
    "The AI compares the student's work with the teacher's answer key and the task instructions and suggests a score (0–100) and feedback. Clear cases are graded automatically and the student is notified; doubtful ones wait for the teacher's review. The teacher can change any grade. If there is no answer key, the AI drafts one, and students never see it.",
    "AI сравнивает работу ученика с ключом ответов учителя и условием задания и предлагает балл (0–100) и отзыв. Очевидные случаи оцениваются автоматически, и ученик получает уведомление; сомнительные ждут проверки учителя. Учитель может изменить любую оценку. Если ключа нет, AI готовит его черновик, и ученики его не видят.",
  ],
  "site.faq.q.tasks": ["Tapşırıq və materialları necə paylaşmaq olar?", "How do I share assignments and materials?", "Как делиться заданиями и материалами?"],
  "site.faq.a.tasks": [
    "Tapşırığı və ya materialı qrupa təyin edin və ya paylaşım linki göndərin. Müəllim hər şagird üzrə kimin açdığını, faylları yüklədiyini və təhvil verdiyini görür.",
    "Assign a task or material to a group or send a share link. For every student, the teacher sees who opened it, downloaded the files and submitted.",
    "Назначьте задание или материал группе или отправьте ссылку. По каждому ученику учитель видит, кто открыл, скачал файлы и сдал работу.",
  ],
  "site.faq.q.analytics": ["Nəticələrdə hansı analitika var?", "What analytics do I get from the results?", "Какая аналитика есть по результатам?"],
  "site.faq.a.analytics": [
    "Median bal, ən çox səhv edilən suallar, mövzu üzrə nəticə və hər sual üzrə doğru, səhv və cavabsız cavabların payı. Məqsəd sadəcə balı yox, səbəbi göstərməkdir: hansı mövzunu növbəti dərsdə təkrar izah etmək lazımdır.",
    "Median score, most-missed questions, results by topic and the share of correct, wrong and unanswered for every question. The aim is to show not just the score but why — which topic to go over again in the next lesson.",
    "Медианный балл, самые сложные вопросы, результат по темам и доля верных, неверных и пропущенных ответов по каждому вопросу. Цель — показать не просто балл, а причину: какую тему стоит повторить на следующем уроке.",
  ],
  "site.faq.q.price": ["Resulio pulsuzdurmu?", "Is Resulio free?", "Resulio бесплатный?"],
  "site.faq.a.price": [
    "Resulio-da pulsuz başlamaq olar. Beta müddətində bütün əsas funksiyalar pulsuzdur. Paket şəxsi hesaba deyil, tədris məkanına aiddir.",
    "You can start using Resulio for free. All core features are free during the beta. A plan belongs to a teaching space, not to a personal account.",
    "Начать пользоваться Resulio можно бесплатно. Во время беты все основные функции бесплатны. Тариф относится к пространству преподавания, а не к личному аккаунту.",
  ],
  "site.faq.q.languages": ["Resulio hansı dillərdə işləyir?", "Which languages does Resulio support?", "На каких языках работает Resulio?"],
  "site.faq.a.languages": [
    "İnterfeys Azərbaycan, rus və ingilis dillərindədir və istənilən vaxt dəyişdirilə bilər. İmtahanların özü istənilən dildə hazırlana bilər.",
    "The interface is available in Azerbaijani, Russian and English and can be switched at any time. Exams themselves can be written in any language.",
    "Интерфейс доступен на азербайджанском, русском и английском, язык можно сменить в любой момент. Сами экзамены можно составлять на любом языке.",
  ],
  "site.faq.q.ai": ["AI ilə sual yaratmaq olarmı?", "Can AI create questions?", "Можно ли создавать вопросы с помощью AI?"],
  "site.faq.a.ai": [
    "Bəli. İmtahan qurucusunda AI ilə sual qaralamaları yaratmaq olar (Azərbaycan, rus, ingilis və alman dillərində). Müəllim qaralamaları yoxlayır, redaktə edir və yalnız sonra imtahana əlavə edir.",
    "Yes. The exam builder can generate draft questions with AI (in Azerbaijani, Russian, English and German). The teacher reviews and edits the drafts before adding them to an exam.",
    "Да. В конструкторе экзаменов можно создавать черновики вопросов с помощью AI (на азербайджанском, русском, английском и немецком). Учитель проверяет и редактирует их перед добавлением в экзамен.",
  ],
  "site.faq.q.install": ["Proqram quraşdırmaq lazımdırmı?", "Do I need to install anything?", "Нужно ли что-то устанавливать?"],
  "site.faq.a.install": [
    "Xeyr. Resulio veb platformadır və kompüter, planşet və ya telefon brauzerində işləyir.",
    "No. Resulio is a web platform and works in the browser on computers, tablets and phones.",
    "Нет. Resulio — веб-платформа, она работает в браузере на компьютере, планшете и телефоне.",
  ],
  "site.faq.q.privacy": ["Məlumatlarım necə qorunur?", "How is my data handled?", "Как обрабатываются мои данные?"],
  "site.faq.a.privacy": [
    "Resulio məlumatlarınızı satmır və reklam məqsədilə üçüncü tərəflərlə paylaşmır. Ətraflı məlumat məxfilik siyasətindədir.",
    "Resulio does not sell your data or share it with third parties for advertising. Details are in the privacy policy.",
    "Resulio не продаёт ваши данные и не передаёт их третьим лицам в рекламных целях. Подробности — в политике конфиденциальности.",
  ],
  "site.faq.q.founder": ["Resulio-nu kim yaradıb?", "Who created Resulio?", "Кто создал Resulio?"],
  "site.faq.a.founder": [
    "Resulio-nun təsisçisi Telman Abdulla-dır. Ətraflı məlumat «Haqqında» səhifəsindədir.",
    "Resulio was founded by Telman Abdulla. More on the About page.",
    "Основатель Resulio — Тельман Абдулла. Подробнее — на странице «О проекте».",
  ],

  // About
  "site.about.h1": ["Resulio haqqında", "About Resulio", "О Resulio"],
  "site.about.whatTitle": ["Resulio nə edir", "What Resulio does", "Что делает Resulio"],
  "site.about.whoTitle": ["Kim üçündür", "Who it is for", "Для кого"],
  "site.about.whoBody": [
    "Resulio-da tədris məkanını müəllim, təlimçi, tədris mərkəzi və ya məktəb yarada bilər. Şagird və tələbələr müəllimin dəvəti ilə qrupa qoşulur. Bir hesabla həm öyrənmək, həm də tədris etmək olar.",
    "A teaching space in Resulio can be created by a teacher, a trainer, a learning centre or a school. Students join a group by their teacher's invitation. One account can be used both to learn and to teach.",
    "Пространство преподавания в Resulio может создать учитель, тренер, учебный центр или школа. Ученики вступают в группу по приглашению учителя. Один аккаунт подходит и для учёбы, и для преподавания.",
  ],
  "site.about.founderTitle": ["Təsisçi", "Founder", "Основатель"],
  "site.about.founderBody": [
    "Resulio Telman Abdulla tərəfindən yaradılıb və inkişaf etdirilir.",
    "Resulio was founded and is developed by Telman Abdulla.",
    "Resulio создан и развивается Тельманом Абдуллой.",
  ],
  "site.about.founderProfiles": ["Açıq profillər", "Public profiles", "Публичные профили"],
  "site.about.nameTitle": ["Ad və rəsmi sayt", "Name and official website", "Название и официальный сайт"],
  "site.about.nameBody": [
    "Platformanın adı Resulio-dur, rəsmi saytı resulio.co ünvanıdır. Şüarı: «İmtahan. Nəticə. İnkişaf.»",
    "The platform is called Resulio and its official website is resulio.co. Its motto: “Exam. Result. Growth.”",
    "Платформа называется Resulio, официальный сайт — resulio.co. Девиз: «Экзамен. Результат. Рост.»",
  ],
  "site.about.contactTitle": ["Əlaqə", "Contact", "Контакты"],
  "site.about.contactBody": ["Suallar və təkliflər üçün e-poçt:", "Email for questions and feedback:", "Эл. почта для вопросов и предложений:"],

  // Landing: assessment platform for Azerbaijan
  "site.lp.az.h1": [
    "Resulio — Azərbaycan üçün onlayn imtahan və qiymətləndirmə platforması",
    "Resulio — an online exam and assessment platform for Azerbaijan",
    "Resulio — платформа онлайн-экзаменов и оценивания для Азербайджана",
  ],
  "site.lp.az.lead": [
    "Resulio Azərbaycan dilində işləyən və məktəb formatlarını (KSQ, BSQ) dəstəkləyən onlayn imtahan və qiymətləndirmə platformasıdır. Müəllimlər, tədris mərkəzləri və məktəblər imtahan yaradır, şagirdlərə link və ya QR kodla paylaşır və nəticələri mövzu üzrə təhlil edir.",
    "Resulio is an online exam and assessment platform that works in Azerbaijani and supports the KSQ and BSQ school formats. Teachers, learning centres and schools create exams, share them with students by link or QR code and analyse the results by topic.",
    "Resulio — платформа онлайн-экзаменов и оценивания, которая работает на азербайджанском языке и поддерживает школьные форматы KSQ и BSQ. Учителя, учебные центры и школы создают экзамены, делятся ими по ссылке или QR-коду и анализируют результаты по темам.",
  ],
  "site.lp.az.localTitle": ["Azərbaycan təhsil mühitinə uyğun", "Built for the Azerbaijani classroom", "Для азербайджанского образования"],
  "site.lp.az.local1": [
    "Əsas dil Azərbaycan dilidir; interfeysi rus və ya ingilis dilinə keçirmək olar.",
    "Azerbaijani is the primary language; the interface can be switched to Russian or English.",
    "Основной язык — азербайджанский; интерфейс можно переключить на русский или английский.",
  ],
  "site.lp.az.local2": [
    "KSQ (kiçik summativ qiymətləndirmə) və BSQ (böyük summativ qiymətləndirmə) formatları.",
    "KSQ and BSQ formats — the small and large summative assessments used in Azerbaijani schools.",
    "Форматы KSQ и BSQ — малое и большое суммативное оценивание в школах Азербайджана.",
  ],
  "site.lp.az.local3": [
    "AI ilə Azərbaycan dilində sual qaralamaları.",
    "AI-generated draft questions in Azerbaijani.",
    "Черновики вопросов на азербайджанском с помощью AI.",
  ],
  "site.lp.az.local4": [
    "İmtahan cədvəlləri standart olaraq Bakı vaxtı ilə qurulur.",
    "Exam schedules default to Baku time.",
    "Расписание экзаменов по умолчанию — по бакинскому времени.",
  ],
  "site.lp.az.local5": [
    "Məktəb dərsləri, abituriyent və buraxılış imtahanına hazırlıq, beynəlxalq imtahanlar (IELTS, TOEFL, SAT), dil, IT və peşə kursları üçün.",
    "For school lessons, university entrance and school-leaving exam prep, international exams (IELTS, TOEFL, SAT), language, IT and professional courses.",
    "Для школьных уроков, подготовки к вступительным и выпускным экзаменам, международных экзаменов (IELTS, TOEFL, SAT), языковых, IT- и профессиональных курсов.",
  ],
  "site.lp.az.stepsTitle": ["Qiymətləndirmə necə işləyir", "How assessment works in Resulio", "Как проходит оценивание в Resulio"],
  "site.lp.az.step1": [
    "Tədris məkanı və qrup yaradın, şagirdləri dəvət kodu, link və ya e-poçt ilə dəvət edin.",
    "Create a teaching space and a group, then invite students by code, link or email.",
    "Создайте пространство и группу, пригласите учеников по коду, ссылке или эл. почте.",
  ],
  "site.lp.az.step2": [
    "İmtahanı hazırlayın və şagirdin görəcəyi formada yoxlayın.",
    "Prepare the exam and preview it exactly as a student will see it.",
    "Подготовьте экзамен и посмотрите его глазами ученика.",
  ],
  "site.lp.az.step3": [
    "İmtahanı qrupa və ya fərdi şagirdlərə link və ya QR kodla göndərin.",
    "Send the exam to a group or to individual students by link or QR code.",
    "Отправьте экзамен группе или отдельным ученикам по ссылке или QR-коду.",
  ],
  "site.lp.az.step4": [
    "Nəticələrdən hansı sualların çətin olduğunu və hansı mövzuların təkrar izaha ehtiyac duyduğunu görün.",
    "See from the results which questions were hard and which topics need a second explanation.",
    "Узнайте из результатов, какие вопросы были сложными и какие темы нужно объяснить ещё раз.",
  ],
  "site.lp.featuresTitle": ["Funksiyalar", "Features", "Возможности"],

  // Landing: for teachers
  "site.lp.teachers.h1": [
    "Müəllimlər üçün Resulio: imtahan, qrup və nəticə analitikası bir yerdə",
    "Resulio for teachers: exams, groups and results analytics in one place",
    "Resulio для учителей: экзамены, группы и аналитика результатов в одном месте",
  ],
  "site.lp.teachers.lead": [
    "Resulio müəllimlərə, təlimçilərə və tədris mərkəzlərinə qrupları idarə etməyə, imtahan və tapşırıq paylaşmağa və nəticələrdən növbəti dərsi planlamağa kömək edir.",
    "Resulio helps teachers, trainers and learning centres run their groups, share exams and assignments, and plan the next lesson from the results.",
    "Resulio помогает учителям, тренерам и учебным центрам вести группы, делиться экзаменами и заданиями и планировать следующий урок по результатам.",
  ],
  "site.lp.teachers.groupsTitle": ["Qruplarınızı idarə edin", "Run your groups", "Ведите свои группы"],
  "site.lp.teachers.examsTitle": ["İmtahan, tapşırıq və materiallar", "Exams, assignments and materials", "Экзамены, задания и материалы"],
  "site.lp.teachers.insightTitle": ["Nəticələrdən növbəti dərsə", "From results to the next lesson", "От результатов к следующему уроку"],
  "site.lp.teachers.insightBody": [
    "Resulio sadəcə balı yox, səbəbi göstərir: hansı sual çətin oldu, hansı mövzu üzrə nəticə zəifdir və növbəti dərsdə nəyi təkrar izah etmək faydalı ola bilər.",
    "Resulio shows not just the score but why: which question was hard, which topic is weak, and what may be worth explaining again in the next lesson.",
    "Resulio показывает не просто балл, а причину: какой вопрос оказался сложным, по какой теме результат слабый и что стоит объяснить ещё раз на следующем уроке.",
  ],
  "site.lp.teachers.accountTitle": ["Bir hesab — öyrənmək, tədris etmək və ya hər ikisi", "One account — to learn, to teach, or both", "Один аккаунт — учиться, преподавать или и то и другое"],
  "site.lp.teachers.accountBody": [
    "Eyni hesabla həm öz tədris məkanınızı idarə edə, həm də başqa müəllimin qrupunda şagird ola bilərsiniz — hesab dəyişmədən.",
    "With the same account you can run your own teaching space and be a student in another teacher's group — without switching accounts.",
    "С одним аккаунтом можно вести своё пространство преподавания и быть учеником в группе другого учителя — без переключения аккаунтов.",
  ],
  "site.lp.teachers.aiTitle": ["AI ilə daha az yoxlama işi", "Less checking work with AI", "Меньше проверки с AI"],
} as const satisfies Record<string, Entry>;
