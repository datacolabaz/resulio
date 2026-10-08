import type { ModuleDetails } from "../../../shared/syllabusModuleDetails";

/**
 * End-of-module blocks of the "AI Engineer – 9 aylıq praktik proqram" syllabus, one entry per month
 * in module order. `title` is the month's title in the program text; `match` must hit the module's
 * title in the database before the backfill (aiEngineeringBackfill.ts) writes anything to it.
 */
export interface AiEngineeringModuleContent {
  month: number;
  title: string;
  match: RegExp;
  details: ModuleDetails;
}

const assessment = (items: string[]): ModuleDetails["assessment"] => ({ heading: "", intro: "", pipeline: "", listIntro: "", items });

/** Lower case with Azerbaijani letters and other diacritics folded: "Süni İntellekt Mühəndisi" → "suni intellekt muhendisi". */
export function foldTitle(title: string): string {
  return title
    .replace(/[əƏ]/g, "e")
    .replace(/[ıIİ]/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Matched against foldTitle(title): AI Engineer(ing), AI Mühəndis(i/liyi), Süni intellekt mühəndisi, Artificial Intelligence Engineer. */
export const AI_ENGINEERING_SYLLABUS_TITLES: readonly RegExp[] = [/\bai[\s-]*(engineer|muhendis)/, /\bsuni[\s-]+intellekt[\s-]+muhendis/, /\bartificial[\s-]+intelligence[\s-]+engineer/];

export function isAiEngineeringTitle(title: string): boolean {
  const folded = foldTitle(title);
  return AI_ENGINEERING_SYLLABUS_TITLES.some((re) => re.test(folded));
}

export const AI_ENGINEERING_MODULE_DETAILS: readonly AiEngineeringModuleContent[] = [
  {
    month: 1,
    title: "Python & Programming Fundamentals",
    match: /\bpython\b/i,
    details: {
      objectives: [
        "Python proqramlaşdırma dilinin əsaslarını mənimsəmək",
        "Proqramlaşdırma məntiqini və problem həll etmə bacarığını inkişaf etdirmək",
        "Funksiyalar, OOP, modullar və paketlərlə işləməyi öyrənmək",
        "Git və GitHub ilə kod versiyalarını idarə etmək",
        "Praktiki Python tətbiqi hazırlamaq",
      ],
      prerequisites: [
        "Proqramlaşdırma üzrə əvvəlcədən təcrübə tələb olunmur",
        "Kompüterdən əsas səviyyədə istifadə bacarığı",
        "Proqramlaşdırmaya və süni intellektə maraq",
      ],
      assessment: assessment([
        "Python ilə funksional mini tətbiqin hazırlanması",
        "Kodun strukturunun və Clean Code prinsiplərinə uyğunluğunun yoxlanılması",
        "GitHub repository təqdimatı",
        "Praktiki tapşırıq üzrə yekun qiymətləndirmə",
      ]),
    },
  },
  {
    month: 2,
    title: "Data Analysis & Mathematics for AI",
    match: /\bdata\s+anal[iy]|\bmath|\briyaziyyat/i,
    details: {
      objectives: [
        "AI üçün datanın hazırlanması və analizini öyrənmək",
        "NumPy və Pandas ilə işləmək",
        "Statistik və riyazi əsasları mənimsəmək",
        "Real datasetlər üzərində praktiki analiz aparmaq",
      ],
      prerequisites: [
        "Python üzrə əsas biliklər",
        "Riyaziyyat üzrə orta məktəb səviyyəsində baza bilikləri",
        "Əvvəlcədən Data Science təcrübəsi tələb olunmur",
      ],
      assessment: assessment([
        "Real dataset üzərində data cleaning və preprocessing",
        "Datasetin statistik və vizual analizi",
        "Analiz nəticələrinin təqdim edilməsi",
        "Praktiki data analysis layihəsinin qiymətləndirilməsi",
      ]),
    },
  },
  {
    month: 3,
    title: "Machine Learning",
    match: /\bmachine\s+learning\b|\bmaşın\s+öyrən/i,
    details: {
      objectives: [
        "Machine Learning alqoritmlərinin əsaslarını öyrənmək",
        "Real datasetlər üzərində model qurmaq və qiymətləndirmək",
        "Scikit-learn ilə praktiki ML layihələri hazırlamaq",
        "Model seçimi və optimallaşdırılmasının əsaslarını mənimsəmək",
      ],
      prerequisites: ["Python üzrə əsas biliklər", "NumPy və Pandas üzrə baza bilikləri", "Statistikaya dair əsas anlayışlar"],
      assessment: assessment([
        "Real dataset əsasında Machine Learning modeli hazırlanması",
        "Modelin train/test edilməsi və qiymətləndirilməsi",
        "Ən azı bir regression və ya classification probleminin həlli",
        "Model nəticələrinin izah edilməsi",
      ]),
    },
  },
  {
    month: 4,
    title: "Deep Learning",
    match: /\bdeep\s+learning\b|\bdərin\s+öyrən/i,
    details: {
      objectives: [
        "Deep Learning və Neural Network əsaslarını öyrənmək",
        "Neyron şəbəkələri qurmaq, öyrətmək və qiymətləndirmək",
        "CNN və Computer Vision əsaslarını mənimsəmək",
        "PyTorch ilə praktiki Deep Learning modelləri hazırlamaq",
        "GPU ilə model təliminin əsaslarını öyrənmək",
      ],
      prerequisites: [
        "Python üzrə yaxşı baza bilikləri",
        "NumPy və Pandas üzrə əsas biliklər",
        "Machine Learning üzrə baza bilikləri",
        "Riyaziyyat və statistika üzrə əsas anlayışlar",
      ],
      assessment: assessment([
        "PyTorch istifadə edərək Deep Learning modeli hazırlanması",
        "Modelin train və validation prosesinin aparılması",
        "Image Classification və ya Object Recognition tapşırığının həlli",
        "Model nəticələrinin qiymətləndirilməsi",
      ]),
    },
  },
  {
    month: 5,
    title: "NLP & Generative AI",
    match: /\bnlp\b|\bgenerative\b|\bgenerativ/i,
    details: {
      objectives: [
        "NLP və Generative AI əsaslarını mənimsəmək",
        "Transformer və LLM-lərin iş prinsipini anlamaq",
        "Müasir LLM-lərlə API vasitəsilə işləmək",
        "Structured Output və Function Calling tətbiq etmək",
        "AI əsaslı text analysis sistemi hazırlamaq",
      ],
      prerequisites: [
        "Python üzrə yaxşı baza bilikləri",
        "Machine Learning üzrə əsas anlayışlar",
        "API və JSON haqqında ilkin anlayış",
      ],
      assessment: assessment([
        "LLM API istifadə edən praktiki tətbiqin hazırlanması",
        "Mətnin analiz edilməsi və nəticənin strukturlaşdırılması",
        "Function Calling və ya Structured Output tətbiqi",
        "AI-powered Text Analysis layihəsinin təqdimatı",
      ]),
    },
  },
  {
    month: 6,
    title: "LLM Applications & RAG",
    match: /\brag\b|\bllm\s+app/i,
    details: {
      objectives: [
        "RAG sistemlərinin arxitekturasını və iş prinsipini öyrənmək",
        "Embeddings və Vector Database ilə işləmək",
        "Sənədlərdən AI Knowledge Base yaratmaq",
        "LangChain ilə LLM tətbiqləri hazırlamaq",
        "RAG əsaslı AI Assistant qurmaq",
      ],
      prerequisites: ["Python üzrə yaxşı biliklər", "LLM və AI API-ləri üzrə əsas anlayışlar", "API və JSON üzrə baza bilikləri"],
      assessment: assessment([
        "PDF/DOCX və ya digər sənədlər əsasında Knowledge Base hazırlanması",
        "Embedding və vector search tətbiqi",
        "RAG pipeline qurulması",
        "AI Knowledge Assistant layihəsinin hazırlanması və test edilməsi",
      ]),
    },
  },
  {
    month: 7,
    title: "AI Agents & Advanced AI Systems",
    match: /\bagent/i,
    details: {
      objectives: [
        "AI Agent arxitekturasını və iş prinsipini öyrənmək",
        "Tool və Function Calling ilə agentlər yaratmaq",
        "Multi-step workflow və agent orchestration tətbiq etmək",
        "Xarici API və database-ləri agentlərə inteqrasiya etmək",
        "Real AI Agent sistemi hazırlamaq",
      ],
      prerequisites: [
        "Python üzrə yaxşı biliklər",
        "LLM və API-lərlə işləmə təcrübəsi",
        "RAG üzrə baza bilikləri",
        "JSON və REST API üzrə əsas anlayışlar",
      ],
      assessment: assessment([
        "Tool istifadə edə bilən AI Agent hazırlanması",
        "Xarici API və ya database inteqrasiyası",
        "Multi-step workflow qurulması",
        "AI Agent layihəsinin real ssenari üzərində nümayiş etdirilməsi",
      ]),
    },
  },
  {
    month: 8,
    title: "Backend, APIs & AI Engineering",
    match: /\bback-?end\b/i,
    details: {
      objectives: [
        "AI sistemləri üçün backend hazırlamağı öyrənmək",
        "REST API və FastAPI ilə işləmək",
        "PostgreSQL və SQL tətbiq etmək",
        "AI modelini backend və database ilə inteqrasiya etmək",
        "Authentication, security və error handling tətbiq etmək",
      ],
      prerequisites: [
        "Python üzrə yaxşı biliklər",
        "LLM və AI tətbiqləri üzrə əsas biliklər",
        "REST API və JSON üzrə baza bilikləri",
        "SQL üzrə ilkin anlayış",
      ],
      assessment: assessment([
        "FastAPI ilə AI backend hazırlanması",
        "PostgreSQL database inteqrasiyası",
        "AI modelinin API vasitəsilə təqdim edilməsi",
        "Authentication və error handling tətbiqi",
        "Backend layihəsinin işlək şəkildə təqdim edilməsi",
      ]),
    },
  },
  {
    month: 9,
    title: "Deployment, MLOps & Final Project",
    match: /\bdeploy|\bmlops\b|\bfinal\b|\byekun\b/i,
    details: {
      objectives: [
        "AI layihəsini production mühitinə çıxarmağı öyrənmək",
        "Docker və Docker Compose ilə işləmək",
        "AI sistemlərinin deployment prosesini mənimsəmək",
        "Monitoring, logging və security tətbiq etmək",
        "Production səviyyəli AI sisteminin arxitekturasını qurmaq",
        "Kurs ərzində əldə edilən bilikləri vahid real AI məhsulunda tətbiq etmək",
      ],
      prerequisites: [
        "Python üzrə yaxşı biliklər",
        "Machine Learning və Deep Learning üzrə biliklər",
        "LLM, RAG və AI Agent təcrübəsi",
        "FastAPI, SQL və PostgreSQL üzrə baza bilikləri",
        "Git və GitHub üzrə əsas biliklər",
      ],
      assessment: {
        heading: "Final Project",
        intro: "Tələbə tam işlək AI məhsulu hazırlamalıdır:",
        pipeline: "Problem → Data → AI Model/LLM → RAG/Agent → Backend → Database → Docker → Deployment",
        listIntro: "Qiymətləndirmə aşağıdakı meyarlar üzrə aparılır:",
        items: [
          "Texniki düzgünlük",
          "AI komponentlərinin düzgün inteqrasiyası",
          "Backend və API arxitekturası",
          "Database istifadəsi",
          "Deployment",
          "Security və error handling",
          "Production architecture",
          "Layihənin təqdimatı və işlək demo",
        ],
      },
    },
  },
];
