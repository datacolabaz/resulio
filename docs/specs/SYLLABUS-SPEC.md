# Resulio — Syllabus / Structured Learning Architecture (owner specification)

Mövcud Resulio layihəsini əvvəlcə tam analiz et. Mövcud Materiallar sistemini, müəllim panelini, tələbə panelini, database strukturunu, authentication/authorization sistemini və mövcud navigation-u başa düş.

Məqsəd sadəcə yeni səhifə əlavə etmək deyil. Resulio üçün gələcəkdə bütün fənlərə və tədris sahələrinə tətbiq oluna bilən Syllabus / Structured Learning Architecture yaratmaqdır.

## 1. ƏSAS KONSEPSİYA
Resulio-da iki ayrı anlayış olmalıdır:

### A. Materials
Sərbəst material kitabxanasıdır. Müəllim müxtəlif fayllar, videolar, mətnlər, PDF-lər, linklər və digər resurslar əlavə edə bilər. Materials bölməsində məcburi ardıcıllıq yoxdur. Tələbə uyğun materialı sərbəst şəkildə aça bilər.

### B. Syllabus
Syllabus müəllimin müəyyən bir fənn/tədris sahəsini ardıcıl şəkildə öyrətməsi üçün structured curriculum sistemidir.
Məsələn: Syllabus: Java Programming. Modules: 1. Java Fundamentals 2. Object-Oriented Programming 3. Collections 4. Exception Handling 5. SQL 6. Spring Boot 7. REST API 8. Security 9. Docker 10. Software Architecture.

Syllabus → Module → Lesson → Theory + Practice + Assessment. Bu hierarchy sistemin əsas arxitekturası olmalıdır.

## 2. SYLLABUS YARATMA
Teacher yeni Syllabus yarada bilməlidir. Fields: Syllabus title, Description, Subject / Field, Level, Cover image, Estimated duration, Language, Status: Draft / Published / Archived. Məsələn: Java Programming, Beginner → Intermediate, Duration: 6 months. Teacher Syllabus yaratdıqdan sonra onun daxilində Module yaradır.

## 3. MODULE
Hər Syllabus-un içində istənilən sayda Module ola bilər. Module fields: Title, Description, Order, Estimated duration, Learning objectives, Prerequisites, Status, Published / Draft. Module-lar drag & drop ilə sıralana bilməlidir.

## 4. LESSON
Hər Module daxilində bir neçə Lesson olmalıdır (məs. Module 1 — Java Fundamentals: Lesson 1 JDK/JVM/JRE, 2 Variables, 3 Data Types, 4 Operators, 5 if/else, 6 switch, 7 Loops).
Lesson fields: Title, Description, Order, Estimated duration, Learning objectives, Theory content, Examples, Teacher Practice, Student Practice, Resources, Assessment, Status.

## 5. THEORY
Hər Lesson-un Theory hissəsi olmalıdır. Content types: Rich text, Code blocks, Images, Videos, Links, Files, Tables. Müəllim dərsi izah etmək üçün theory materialını istifadə edə bilməlidir.

## 6. TEACHER PRACTICE
Teacher Practice tələbəyə homework vermək üçün deyil. Müəllimin dərs zamanı tələbə ilə birlikdə həll etdiyi və izah etdiyi praktik tasklar üçündür. Məs. Theory: Java if/else; Teacher Practice: "Student score əsasında Pass/Fail müəyyən edən proqram yaz."
Task fields: Task title, Problem statement, Difficulty, Expected outcome, Hints, Example input, Example output, Solution / Teacher notes, Attachments. Teacher bunu dərs zamanı açıb izah edə bilməlidir.

## 7. STUDENT PRACTICE
Teacher Practice-dən ayrıca. Tələbənin özü həll etdiyi tasklar (məs. Score əsasında A/B/C/D/F grade müəyyən et).
Fields: Task, Instructions, Difficulty, Deadline, Submission type, Expected result, Hints, Teacher review, Auto evaluation, Score, Feedback.

## 8. LESSON COMPLETION
Tələbə Lesson-u tamamlamadan növbəti Lesson açılmamalıdır. Completion logic configurable olmalıdır. Default: Theory viewed/completed + Required Teacher Practice completed + Required Student Practice completed + Lesson Assessment passed (əgər aktivdirsə) → Lesson Completed → sonrakı Lesson unlock.

## 9. MODULE UNLOCK
Module yalnız əvvəlki Module tamamlandıqdan sonra açılmalıdır. Default: All required Lessons completed + Required Practice Tasks completed + Module Assessment passed → Module Completed → Next Module Unlock.

## 10. STUDENT PROGRESS
Student panelində Syllabus progress (Overall %, hər Module üçün progress bar, Locked). Student görməlidir: Completed lessons, Current lesson, Locked lessons, Completed practice tasks, Pending practice tasks, Assessment scores, Module progress, Overall progress.

## 11. LOCKED STATE UX
Locked content aydın göstərilməlidir: "🔒 Module 3 — Complete Module 2 to unlock this module." / "🔒 Lesson 5 — Complete Lesson 4 first." İstifadəçi locked content-in adını görə bilər, content-in özünə giriş mümkün olmamalıdır.

## 12. TEACHER OVERRIDE
Teacher və Admin müəyyən tələbə üçün "Unlock Module" / "Unlock Lesson" edə bilməlidir. Audit record: Who unlocked, Student, Content, Date/time, Reason. Override progression logic-i pozmamalıdır; sadəcə həmin student üçün manual exception yaradır.

## 13. ENROLLMENT
Student Syllabus-a enroll olduqda öz progress record-u yaranır. Eyni Syllabus-da 100 tələbə ola bilər, hər birinin progress-i ayrıca saxlanır (Student A → Module 3, B → Module 1, C → Module 5). Eyni curriculum, student-specific progression.

## 14. TEACHER PANEL
Syllabus → Modules → Lessons. Lesson daxilində tab-lar: Theory, Teacher Practice, Student Practice, Assessment. Əməliyyatlar: lesson reorder, module reorder, publish/unpublish, duplicate lesson, duplicate module, preview as student.

## 15. STUDENT PANEL
Structured learning path (✅ Module 1 → ✅ Lesson 1..3, 🔵 Lesson 4 — Current; 🔒 Module 2; 🔒 Module 3). Student yalnız icazəli content-i aça bilər.

## 16. ASSESSMENT INTEGRATION
Mövcud Assessment sistemi ilə inteqrasiya. Səviyyələr: Lesson Assessment, Module Assessment, Final Assessment. Result progression-a təsir edə bilər (Pass mark 70%: 82% → passed, next module unlocked; 58% → incomplete, retry allowed). Retry policy configurable.

## 17. COMPLETION CRITERIA CONFIGURATION
Syllabus və ya Module yaradarkən seçim: Require theory completion, Require practice completion, Require assessment, Require minimum score, Require teacher approval. Bütün fənlər üçün eyni sərt qayda məcburi olmasın.

## 18. CERTIFICATE / FINAL COMPLETION
100% Syllabus completion + Final Assessment passed → "Completed". Gələcəkdə certificate generation üçün uyğun data structure saxlanmalıdır.

## 19. DATABASE ARCHITECTURE
Mövcud database strukturunu analiz et və reusable relational model qur. Minimum conceptlər: User, Teacher, Student, Syllabus, SyllabusModule, Lesson, LessonContent, TeacherPracticeTask, StudentPracticeTask, Assessment, Question, SyllabusEnrollment, LessonProgress, ModuleProgress, TaskSubmission, AssessmentAttempt, ManualUnlock, CompletionRule. Mövcud sistemdə uyğun entity/table varsa, duplicate yaratma. Mövcud architecture ilə inteqrasiya et.

## 20. IMPORTANT: DO NOT BREAK EXISTING MATERIALS
Materials-i silmə və Syllabus ilə qarışdırma. Materials: free-access resource library. Syllabus: structured sequential curriculum. Material Syllabus daxilində resource kimi istifadə oluna bilər (Lesson 1 → Theory → PDF Material → Video Material → Practice Task), amma Material özü Syllabus olmaq məcburiyyətində deyil.

## 21. REUSABILITY
Bir Syllabus müxtəlif qruplara/class-lara tətbiq oluna bilməlidir (Group A, B, C). Syllabus-un özü ilə student progress məlumatlarını qarışdırma.

## 22. VERSIONING
Gələcək üçün versioning (v1.0, v1.1). Müəllim syllabus-u dəyişəndə başlayan tələbələrin progress-i pozulmamalıdır → immutable published version + draft editing modeli.

## 23. ANALYTICS
Foundation: Class completion rate, Module completion rate, Lesson completion rate, Average assessment score, Most difficult lessons, Most failed tasks, Students who are stuck, Students who are progressing, Average time spent per lesson.

## 24. UX PRINCIPLE
Teacher: "Create → Organize → Teach → Assign → Assess → Track". Student: "Learn → Practice → Submit → Pass → Unlock → Progress". Bu iki workflow əsas navigation məntiqini formalaşdırsın.

## 25. CRITICAL REQUIREMENT
Kod yazmağa dərhal başlama. Əvvəlcə analiz et və göstər:
1. Mövcud architecture
2. Mövcud database/entities
3. Materials sisteminin necə işlədiyi
4. Syllabus üçün təklif olunan database model
5. User roles və permissions
6. Teacher workflow
7. Student workflow
8. Unlock/progression logic
9. Mövcud sistemlə integration nöqtələri
10. Hansı faylların dəyişəcəyi
11. Hansı yeni faylların yaradılacağı
12. Potential breaking changes
13. Migration strategy
Sonra implementation plan hazırla. Təsdiqdən sonra mərhələli implement: (1) database + backend/domain model, (2) teacher Syllabus builder, (3) student progression, (4) assessment integration, (5) analytics, (6) UX polish. Mövcud işləyən funksiyaları pozma. Kod keyfiyyətli, scalable, müxtəlif fənlərə tətbiq oluna bilən olsun. Məqsəd "Java kursu" yaratmaq deyil; istənilən müəllimin Fənn → Syllabus → Modules → Lessons → Theory → Teacher Practice → Student Practice → Assessment → Progress → Unlock strukturunda tam tədris proqramı yarada bilməsidir.

## 26. SYLLABUS ACCESS MANAGEMENT
Teacher-in mövcud Groups sistemi var. Published Syllabus üçün giriş verilməsi:
A. Bir və ya bir neçə Group (☑️ Java Group A, ☑️ Java Group B, ☐ Python Group) → "Grant Access" → həmin qruplardakı tələbələr görə və başlaya bilər.
B. Individual Students (Group A + Group B + Ali, Leyla, Murad). Group-based və individual access birlikdə.

## 27. ACCESS STATUS
Hər access record: Active, Revoked, Expired, Pending. Revoke mümkün; revoke olunanda progress silinmir; yenidən access veriləndə progress bərpa olunur.

## 28. ACCESS DATES
İstəyə görə Start date / End date (01.10.2026 → 01.04.2027). End date keçdikdən sonra giriş yoxdur, progress və tarixçə saxlanır.

## 29. STUDENT LEARNING ACTIVITY TRACKING
Event/activity olaraq qeyd et:
- Syllabus: opened, viewed, started, completed
- Module: opened, completed
- Lesson: opened, started, completed
- Theory: opened, completed
- Video: opened, started, progress, completed
- Practice: task opened, started, submitted, resubmitted, completed
- Assessment: opened, started, submitted, passed, failed
- Navigation: next lesson unlocked, module unlocked, manual unlock

## 30. DO NOT TRACK ONLY "COMPLETED"
Event/activity history saxlanmalıdır (məs. Ali / Variables: 10:02 Lesson opened, 10:05 Theory opened, 10:17 Practice opened, 10:31 Practice submitted, 10:35 Lesson completed).

## 31. LAST ACTIVITY
Hər student üçün: Last activity date/time, Current module, Current lesson, Current progress, Last completed lesson, Last completed task. Teacher aktiv/passiv tələbələri görə bilsin.

## 32. TEACHER SYLLABUS ANALYTICS
Syllabus detail səhifəsində Analytics bölməsi: Students, Overall Completion, Active Students, Inactive Students, Average Assessment Score.

## 33. STUDENT-LEVEL ANALYTICS
Cədvəl: Student | Progress | Current Lesson | Practice | Assessment | Last Activity. Real-time və ya yaxın real-time.

## 34. GROUP-LEVEL ANALYTICS
Qrup üzrə: Students, Average Progress, Average Assessment Score, Completed Module N: x/y, At Risk sayı.

## 35. MODULE ANALYTICS
Started, Completed, Completion rate, Average score, Average time to complete, Practice completion rate, Assessment pass rate, Retry rate.

## 36. LESSON ANALYTICS
Opened, Completed, Completion rate, Practice completion, Average score, Average attempts — çətin mövzuları müəyyən etmək üçün.

## 37. PRACTICE TASK ANALYTICS
Open rate, Start rate, Submission rate, Completion rate, Average score, Average attempts, Average time to completion, Number of students requiring teacher help.

## 38. LEARNING FUNNEL
Students with access → Syllabus opened → Module started → Lesson opened → Theory completed → Practice started → Practice submitted → Assessment attempted → Assessment passed → Module completed.

## 39. AT-RISK STUDENTS
Sadə rule-based: No activity > 7 days OR Assessment failed >= 2 OR Progress significantly below group average (həmçinin practice tamamlamır, bir Lesson-da qeyri-adi uzun qalır) → At Risk. Gələcək AI analytics üçün foundation.

## 40. TEACHER INSIGHTS
Sadə rule-based insights (məs. "Module 2-də tələbələrin yalnız 58%-i Practice Task 3-ü tamamlayıb", "Generics mövzusunda orta score digərlərindən 18% aşağıdır", "5 tələbə son 7 gündə aktiv olmayıb", "Group A Module 2-də Group B-dən sürətli irəliləyir"). Gələcəkdə AI ilə genişlənəcək.

## 41. PRIVACY & PERMISSIONS
Teacher yalnız öz syllabus-larına, öz group-larına, öz tələbələrinə aid analytics görür. Student yalnız öz progress/activity məlumatlarını görür. Admin uyğun permissions əsasında sistem səviyyəsində.

## 42. DATA ARCHITECTURE
LearningActivity: id, userId, syllabusId, moduleId, lessonId, taskId, assessmentId, activityType, timestamp, duration, metadata. activityType: SYLLABUS_OPENED, MODULE_OPENED, LESSON_OPENED, THEORY_VIEWED, VIDEO_STARTED, VIDEO_COMPLETED, PRACTICE_OPENED, PRACTICE_STARTED, PRACTICE_SUBMITTED, ASSESSMENT_STARTED, ASSESSMENT_SUBMITTED, ASSESSMENT_PASSED, ASSESSMENT_FAILED, MODULE_COMPLETED, LESSON_COMPLETED, SYLLABUS_COMPLETED. Yeni type-lar əlavə etmək mümkün olmalıdır.

## 43. IMPORTANT PRODUCT PRINCIPLE
Access ≠ Progress; Progress ≠ Completion; Completion ≠ Mastery. Ayrı anlayışlar kimi modelləşdir və analytics-də ayrıca göstər.

## 44. FUTURE AI LEARNING ANALYTICS
Data architecture gələcək AI insight-larına uyğun olsun ("Bu qrupda ən çətin mövzular Variables, Generics, Exception Handling"; "Ali-nin progress-i qrup ortalamasından 24% aşağıdır və 9 gündür aktiv deyil"). AI layer hazırda implement edilməsin.

## 45. FINAL WORKFLOW
Teacher: Create Syllabus → Add Modules → Add Lessons → Add Theory → Add Teacher Practice → Add Student Practice → Add Assessment → Publish → Select Groups / Students → Grant Access → Monitor Progress → Analyze Learning Activity → Identify Difficult Topics / At-Risk Students → Take Action.
Student: Receive Access → Open Syllabus → Learn Theory → Complete Practice → Take Assessment → Pass → Next Lesson Unlocks → Next Module Unlocks → Complete Syllabus.

Bu architecture Resulio-nun əsas Learning Management + Assessment + Learning Analytics sisteminə çevrilməsi üçün foundation kimi hazırlanmalıdır.
