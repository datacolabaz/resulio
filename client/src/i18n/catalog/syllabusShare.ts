import type { Entry } from "../types";

/** Public syllabus share link (`/syllabus/<code>`) and the join requests sent from it. Tuple order: [az, en, ru]. */
export const syllabusShare = {
  // Public page
  "sylShare.page.eyebrow": ["Kurs proqramı", "Course programme", "Программа курса"],
  "sylShare.page.notFoundTitle": ["Səhifə tapılmadı", "Page not found", "Страница не найдена"],
  "sylShare.page.notFoundBody": [
    "Link səhv yazılıb, müəllim onu söndürüb və ya proqram artıq paylaşılmır.",
    "The link is mistyped, the teacher turned it off, or the programme is no longer shared.",
    "Ссылка набрана с ошибкой, преподаватель её отключил или программа больше не публикуется.",
  ],
  "sylShare.page.teacher": ["Müəllim", "Teacher", "Преподаватель"],
  "sylShare.page.modules": ["{count} modul", "{count} {count|module|modules}", "{count} {count|модуль|модуля|модулей}"],
  "sylShare.page.lessons": ["{count} dərs", "{count} {count|lesson|lessons}", "{count} {count|урок|урока|уроков}"],
  "sylShare.page.hours": ["≈ {hours} saat", "≈ {hours} h", "≈ {hours} ч"],
  "sylShare.page.programme": ["Proqram", "Programme", "Программа"],
  "sylShare.page.module": ["Modul {n}", "Module {n}", "Модуль {n}"],
  "sylShare.page.lessonList": ["Dərslər", "Lessons", "Уроки"],
  "sylShare.page.projects": ["Praktik layihələr", "Practical projects", "Практические проекты"],
  "sylShare.page.assessments": ["Modul yoxlamaları", "Module assessments", "Проверки модуля"],
  "sylShare.page.final": ["Yekun layihə və qiymətləndirmə", "Final project and assessment", "Итоговый проект и оценивание"],
  "sylShare.page.cta": ["Bu proqrama qoşulmaq istəyirəm", "I want to join this programme", "Хочу присоединиться к этой программе"],
  "sylShare.page.ownerBanner": [
    "Bu, syllabus-unuzun ictimai səhifəsinin önizləməsidir. Linki açanlar onu belə görür.",
    "This is a preview of your syllabus' public page. People who open the link see it like this.",
    "Это предпросмотр публичной страницы вашего силлабуса. Так её видят те, кто открывает ссылку.",
  ],
  "sylShare.page.ownerCta": ["Öz proqramınıza müraciət göndərə bilməzsiniz.", "You can't send a request to your own programme.", "Нельзя подать заявку на собственную программу."],
  "sylShare.page.metaDescription": ["{title} — {teacher} tərəfindən kurs proqramı", "{title} — a course programme by {teacher}", "{title} — программа курса от {teacher}"],

  // Joining
  "sylShare.join.title": ["Necə qoşulmaq olar", "How to join", "Как присоединиться"],
  "sylShare.join.groupsIntro": ["Yaxın zamanda başlayan qruplar", "Groups starting soon", "Группы, которые скоро стартуют"],
  "sylShare.join.groupCta": ["Bu qrupa qoşulmaq üçün müraciət et", "Request to join this group", "Подать заявку в эту группу"],
  "sylShare.join.noGroups": [
    "Bu proqram üzrə yaxın zamanda yeni qrup planlaşdırılmır.",
    "No new group is planned for this programme in the near future.",
    "Новых групп по этой программе в ближайшее время не планируется.",
  ],
  "sylShare.join.individualCta": [
    "Fərdi dərs / fərdi iştirak üçün müraciət et",
    "Request individual lessons / participation",
    "Подать заявку на индивидуальные занятия / участие",
  ],
  "sylShare.join.member": ["Siz bu qrupdasınız.", "You're in this group.", "Вы уже в этой группе."],
  "sylShare.join.hasAccess": ["Bu proqram sizə artıq açıqdır.", "This programme is already open to you.", "Эта программа вам уже открыта."],
  "sylShare.join.openSyllabus": ["Proqramı aç", "Open the programme", "Открыть программу"],
  "sylShare.join.signIn": [
    "Müraciət göndərmək üçün daxil olun — sonra bu səhifəyə qayıdacaqsınız.",
    "Sign in to send a request — you'll come back to this page.",
    "Войдите, чтобы отправить заявку, — после входа вы вернётесь на эту страницу.",
  ],
  "sylShare.join.pending": ["Müraciətiniz göndərilib, müəllimin cavabını gözləyir.", "Your request was sent and is waiting for the teacher.", "Заявка отправлена и ждёт ответа преподавателя."],
  "sylShare.join.cancel": ["Müraciəti geri götür", "Withdraw request", "Отозвать заявку"],
  "sylShare.join.cancelConfirm": ["Müraciəti geri götürmək istəyirsiniz?", "Withdraw this request?", "Отозвать эту заявку?"],
  "sylShare.join.cancelled": ["Müraciət geri götürüldü", "Request withdrawn", "Заявка отозвана"],
  "sylShare.join.sent": ["Müraciətiniz göndərildi", "Your request was sent", "Заявка отправлена"],
  "sylShare.join.alreadySent": ["Bu müraciət artıq göndərilib", "This request was already sent", "Эта заявка уже отправлена"],
  "sylShare.join.myRequests": ["Müraciətlərim", "My requests", "Мои заявки"],
  "sylShare.join.requestGroup": ["Qrup: {group}", "Group: {group}", "Группа: {group}"],
  "sylShare.join.requestIndividual": ["Fərdi iştirak", "Individual participation", "Индивидуальное участие"],
  "sylShare.join.sentAt": ["Göndərilib: {date}", "Sent: {date}", "Отправлена: {date}"],
  "sylShare.join.teacherNote": ["Müəllimin qeydi: {note}", "Teacher's note: {note}", "Комментарий преподавателя: {note}"],
  "sylShare.status.PENDING": ["Gözləyir", "Pending", "Ожидает"],
  "sylShare.status.ACCEPTED": ["Qəbul edildi", "Accepted", "Принята"],
  "sylShare.status.REJECTED": ["Qəbul edilmədi", "Declined", "Отклонена"],
  "sylShare.status.CANCELLED": ["Geri götürülüb", "Withdrawn", "Отозвана"],

  // Request form
  "sylShare.form.title": ["Müəllimə müraciət", "Request to the teacher", "Заявка преподавателю"],
  "sylShare.form.name": ["Adınız", "Your name", "Ваше имя"],
  "sylShare.form.syllabus": ["Proqram", "Programme", "Программа"],
  "sylShare.form.type": ["Müraciət növü", "Request type", "Тип заявки"],
  "sylShare.form.typeGroup": ["Qrupa qoşulma: {group}", "Join a group: {group}", "Вступление в группу: {group}"],
  "sylShare.form.message": ["Müəllimə mesajınız (istəyə bağlı)", "Your message to the teacher (optional)", "Сообщение преподавателю (необязательно)"],
  "sylShare.form.messagePlaceholder": [
    "Məsələn: hansı günlər uyğundur, hazırkı səviyyəniz…",
    "E.g. which days suit you, your current level…",
    "Например: какие дни удобны, ваш текущий уровень…",
  ],
  "sylShare.form.submit": ["Müraciət göndər", "Send request", "Отправить заявку"],
  "sylShare.form.note": [
    "Müraciət kursun materiallarını açmır: müəllim qəbul etdikdən sonra sizinlə əlaqə saxlayacaq və ya sizi qrupa əlavə edəcək.",
    "A request does not open the course materials: once the teacher accepts, they will add you to the group or get in touch.",
    "Заявка не открывает материалы курса: после принятия преподаватель добавит вас в группу или свяжется с вами.",
  ],

  // Teacher: share link
  "sylShare.link.title": ["İctimai syllabus linki", "Public syllabus link", "Публичная ссылка на силлабус"],
  "sylShare.link.help": [
    "Linki açan hər kəs proqramın strukturunu görür və qoşulmaq üçün müraciət göndərə bilər. Link heç bir dərsə, materiala və ya tapşırığa giriş vermir. Qrup dəvət linklərindən ayrıdır.",
    "Anyone with the link sees the programme outline and can send a request to join. The link opens no lessons, materials or tasks. It is separate from group invite links.",
    "Любой, у кого есть ссылка, видит структуру программы и может отправить заявку. Ссылка не открывает уроки, материалы и задания. Она отдельна от ссылок-приглашений в группы.",
  ],
  "sylShare.link.notPublished": ["Linki paylaşmaq üçün əvvəlcə syllabus-u dərc edin.", "Publish the syllabus first to share its link.", "Сначала опубликуйте силлабус, чтобы поделиться ссылкой."],
  "sylShare.link.archived": ["Arxivdəki syllabus paylaşılmır.", "An archived syllabus can't be shared.", "Архивный силлабус нельзя опубликовать по ссылке."],
  "sylShare.link.create": ["Link yarat", "Create link", "Создать ссылку"],
  "sylShare.link.regenerate": ["Yeni link yarat", "Generate a new link", "Создать новую ссылку"],
  "sylShare.link.regenerateConfirm": ["Köhnə link dərhal işləməyi dayandıracaq. Davam edilsin?", "The old link stops working at once. Continue?", "Старая ссылка сразу перестанет работать. Продолжить?"],
  "sylShare.link.disable": ["Linki söndür", "Turn link off", "Отключить ссылку"],
  "sylShare.link.enable": ["Linki yenidən aç", "Turn link back on", "Снова включить ссылку"],
  "sylShare.link.disabledNote": ["Link söndürülüb: açanlar «səhifə tapılmadı» görür.", "The link is off: visitors see “page not found”.", "Ссылка отключена: посетители видят «страница не найдена»."],
  "sylShare.link.disabledToast": [
    "Link söndürülüb. Onu «Giriş» bölməsində yenidən aça bilərsiniz.",
    "The link is turned off. You can turn it back on in the Access tab.",
    "Ссылка отключена. Включить её снова можно на вкладке «Доступ».",
  ],
  "sylShare.link.openPage": ["Səhifəni aç", "Open page", "Открыть страницу"],

  // Teacher: groups offered on the page
  "sylShare.listing.title": ["Syllabus səhifəsində göstərilən qruplar", "Groups shown on the syllabus page", "Группы на странице силлабуса"],
  "sylShare.listing.help": [
    "Səhifədə yalnız işarələdiyiniz və bu gündən {days} gün ərzində başlayan qruplar göstərilir. Qrupun başlama tarixini qrup ayarlarında yazın.",
    "The page shows only the groups you tick that start within {days} days from today. Set a group's start date in its settings.",
    "На странице показываются только отмеченные группы, которые стартуют в ближайшие {days} дн. Дату старта задайте в настройках группы.",
  ],
  "sylShare.listing.toggle": ["Bu qrupu syllabus səhifəsində göstər", "Show this group on the syllabus page", "Показывать эту группу на странице силлабуса"],
  "sylShare.listing.noStart": ["Başlama tarixi yoxdur — səhifədə görünməyəcək.", "No start date — it won't appear on the page.", "Нет даты старта — группа не появится на странице."],
  "sylShare.listing.outOfWindow": ["Başlama tarixi {date} — hazırda səhifədə görünmür.", "Starts {date} — not shown on the page right now.", "Старт {date} — сейчас не показывается на странице."],
  "sylShare.listing.visible": ["Başlama tarixi {date} — səhifədə görünür.", "Starts {date} — shown on the page.", "Старт {date} — показывается на странице."],
  "sylShare.listing.hidden": ["Başlama tarixi {date}.", "Starts {date}.", "Старт {date}."],

  // Teacher: requests
  "syllabus.tab.requests": ["Müraciətlər", "Requests", "Заявки"],
  "sylShare.requests.title": ["Kurs / syllabus müraciətləri", "Course / syllabus requests", "Заявки на курс / силлабус"],
  "sylShare.requests.help": [
    "Tələbələrin ictimai syllabus səhifəsindən göndərdiyi müraciətlər.",
    "Requests students sent from the public syllabus page.",
    "Заявки, отправленные студентами с публичной страницы силлабуса.",
  ],
  "sylShare.requests.group": ["Qrup müraciətləri", "Group requests", "Заявки в группы"],
  "sylShare.requests.individual": ["Fərdi müraciətlər", "Individual requests", "Индивидуальные заявки"],
  "sylShare.requests.empty": ["Hələ müraciət yoxdur.", "No requests yet.", "Заявок пока нет."],
  "sylShare.requests.answered": ["Cavablandırılanlar", "Answered", "Рассмотренные"],
  "sylShare.requests.accept": ["Qəbul et", "Accept", "Принять"],
  "sylShare.requests.reject": ["Rədd et", "Decline", "Отклонить"],
  "sylShare.requests.acceptTitle": ["Müraciəti qəbul et", "Accept the request", "Принять заявку"],
  "sylShare.requests.rejectTitle": ["Müraciəti rədd et", "Decline the request", "Отклонить заявку"],
  "sylShare.requests.acceptGroupNote": [
    "{student} «{group}» qrupuna əlavə olunacaq və qrupa açıq olan syllabus-lara giriş alacaq.",
    "{student} will be added to the group “{group}” and get the syllabi open to that group.",
    "{student} будет добавлен(а) в группу «{group}» и получит доступ к силлабусам этой группы.",
  ],
  "sylShare.requests.acceptIndividualNote": [
    "Müraciət qəbul edilmiş kimi qeyd olunacaq və tələbəyə bildiriş gedəcək. Proqram açılmayacaq: tələbə ilə əlaqə saxlayın və ya onu qrupa əlavə edin.",
    "The request is marked accepted and the student is notified. The programme stays closed: get in touch or add the student to a group.",
    "Заявка будет отмечена как принятая, студент получит уведомление. Программа не откроется: свяжитесь со студентом или добавьте его в группу.",
  ],
  "sylShare.requests.acceptIndividualOpenNote": [
    "Müraciət qəbul ediləcək, proqram {student} üçün fərdi olaraq açılacaq və tələbəyə bildiriş gedəcək.",
    "The request is accepted, the programme opens to {student} individually and the student is notified.",
    "Заявка будет принята, программа откроется для {student} индивидуально, студент получит уведомление.",
  ],
  "sylShare.requests.grantAccess": [
    "Proqramı bu tələbəyə indi fərdi olaraq aç",
    "Open the programme to this student individually now",
    "Сразу открыть программу этому студенту индивидуально",
  ],
  "sylShare.requests.note": ["Tələbəyə qeyd (istəyə bağlı)", "Note to the student (optional)", "Комментарий студенту (необязательно)"],
  "sylShare.requests.reason": ["Səbəb (istəyə bağlı)", "Reason (optional)", "Причина (необязательно)"],
  "sylShare.requests.acceptedToast": ["Müraciət qəbul edildi", "Request accepted", "Заявка принята"],
  "sylShare.requests.acceptedOpenToast": [
    "Müraciət qəbul edildi, proqram tələbəyə açıldı",
    "Request accepted, the programme is open to the student",
    "Заявка принята, программа открыта студенту",
  ],
  "sylShare.requests.rejectedToast": ["Müraciət rədd edildi", "Request declined", "Заявка отклонена"],
  "sylShare.requests.decidedAt": ["Cavab: {date}", "Answered: {date}", "Ответ: {date}"],
  "sylShare.requests.newCount": ["{count} yeni müraciət", "{count} new {count|request|requests}", "{count} {count|новая заявка|новые заявки|новых заявок}"],

  // Teacher: pending requests across syllabi (syllabus list)
  "sylShare.inbox.title": ["Gözləyən müraciətlər", "Pending requests", "Ожидающие заявки"],
  "sylShare.inbox.help": [
    "Tələbələrin ictimai syllabus linklərindən göndərdiyi və cavabınızı gözləyən müraciətlər.",
    "Requests students sent from your public syllabus links that are waiting for your answer.",
    "Заявки, отправленные студентами по публичным ссылкам на силлабусы и ожидающие вашего ответа.",
  ],
  "sylShare.inbox.view": ["Bax", "View", "Открыть"],
  "sylShare.inbox.showAll": ["Hamısını göstər ({count})", "Show all ({count})", "Показать все ({count})"],
  "sylShare.inbox.showLess": ["Daha az göstər", "Show less", "Свернуть"],

  // Student dashboard
  "sylShare.mine.title": ["Kurs müraciətlərim", "My course requests", "Мои заявки на курсы"],
  "sylShare.mine.open": ["Səhifəyə bax", "View page", "Открыть страницу"],

  // Errors
  "error.SYLLABUS_SHARE_DISABLED": ["Bu syllabus-un linki söndürülüb.", "This syllabus' link is turned off.", "Ссылка на этот силлабус отключена."],
  "error.SYLLABUS_OWN_REQUEST": ["Öz proqramınıza müraciət göndərə bilməzsiniz.", "You can't send a request to your own programme.", "Нельзя подать заявку на собственную программу."],
  "error.SYLLABUS_ALREADY_HAS_ACCESS": ["Bu proqram sizə artıq açıqdır.", "This programme is already open to you.", "Эта программа вам уже открыта."],
  "error.JOIN_REQUEST_GROUP_UNAVAILABLE": [
    "Bu qrupa artıq müraciət etmək mümkün deyil. Səhifəni yeniləyin.",
    "This group no longer takes requests. Refresh the page.",
    "В эту группу больше нельзя подать заявку. Обновите страницу.",
  ],
  "error.JOIN_REQUEST_GROUP_AVAILABLE": [
    "Bu proqram üzrə yaxın zamanda başlayan qrup var — həmin qrupa müraciət edin.",
    "A group for this programme starts soon — send a request to that group.",
    "По этой программе скоро стартует группа — подайте заявку в неё.",
  ],
  "error.JOIN_REQUEST_NOT_PENDING": [
    "Bu müraciətə artıq cavab verilib və ya o, geri götürülüb.",
    "This request has already been answered or withdrawn.",
    "На эту заявку уже ответили, или она отозвана.",
  ],
} as const satisfies Record<string, Entry>;
