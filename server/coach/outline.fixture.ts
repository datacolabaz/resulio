import type { PageText } from "./chunker";

/**
 * The outline of the production report ("aparat teminati 1.pdf", 42 pages): a title page with the
 * author's name, a "Mündəricat" page whose printed page numbers are two less than the PDF pages,
 * then 40 pages of lectures. One TOC topic is a single page, one is 14 pages with sub-headings.
 */

export const AUTHOR = "İlkin Abbasov";

const TITLE_PAGE = [
  "AZƏRBAYCAN RESPUBLİKASI TƏHSİL NAZİRLİYİ",
  "Azərbaycan Texniki Universiteti",
  "Kompüter sistemləri kafedrası",
  AUTHOR,
  "APARAT TƏMİNATI",
  "Mühazirə konspekti",
  "Bakı 2023",
].join("\n");

/** PDF page → heading printed at the top of that page. */
export const HEADINGS: Record<number, string> = {
  3: "1. EHM-LƏRİN NƏSİLLƏRƏ GÖRƏ XÜSUSİYYƏTLƏRİ",
  7: "2. KOMPÜTERİN STRUKTUR SXEMİ VƏ TƏRKİBİ",
  11: "3. CON FON NEYMAN ARXİTEKTURASI",
  13: "4. PERİFERİYA HİSSƏSİ",
  18: "5. ANA PLATA",
  19: "6. sistem bloku daxili qurluşu",
  23: "7. USB",
  29: "8. YADDAŞ QURĞULARI",
  33: "8.1. OPERATİV YADDAŞ",
  38: "8.2. XARİCİ YADDAŞ QURĞULARI",
};

const TOC_PAGE = [
  "MÜNDƏRİCAT",
  "1. EHM-lərin nəsillərə görə xüsusiyyətləri ........ 1",
  "2. Kompüterin struktur sxemi və tərkibi ........ 5",
  "3. CON FON NEYMAN ARXİTEKTURASI ........ 9",
  "4. Periferiya hissəsi ........ 11",
  "5. Ana plata ........ 16",
  "6. sistem bloku daxili qurluşu ........ 17",
  "7. USB ........ 21",
  "8. Yaddaş qurğuları ........ 27",
].join("\n");

const SENTENCES = [
  "Kompüterin əsas hissəsi olan prosessor əmrləri yaddaşdan oxuyur, deşifrə edir və icra edir.",
  "Bu prinsipləri ilk dəfə Con fon Neyman təsvir etmişdir və müasir EHM də onlara əsaslanır.",
  "Məlumat xarici qurğulara adətən USB interfeysi ilə ötürülür, bu da qoşulmanı sadələşdirir.",
  "Hər EHM nəslində element bazası dəyişmiş, sürət artmış, ölçülər isə kiçilmişdir.",
  "Daxili qurğular ana plata üzərində yerləşir və şin vasitəsilə bir-biri ilə əlaqələnir.",
];

/** About one chunk of lecture text: three paragraphs of real sentences. */
function lecture(page: number): string {
  const sentence = (k: number) => SENTENCES[(page + k) % SENTENCES.length];
  const paragraph = (p: number) => Array.from({ length: 6 }, (_, k) => sentence(p * 6 + k)).join(" ");
  return [0, 1, 2].map(paragraph).join("\n\n");
}

const page = (n: number, text: string): PageText => ({ page: n, text, method: "TEXT", quality: null });

export function bodyPages(from = 3, to = 42): PageText[] {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return page(n, HEADINGS[n] ? `${HEADINGS[n]}\n\n${lecture(n)}` : lecture(n));
  });
}

/** The material as uploaded: title page, table of contents, lectures. */
export function aparatPages(): PageText[] {
  return [page(1, TITLE_PAGE), page(2, TOC_PAGE), ...bodyPages()];
}

/** The same material without a table of contents (page 2 is a short annotation). */
export function aparatPagesWithoutToc(): PageText[] {
  return [page(1, TITLE_PAGE), page(2, "Annotasiya\nVəsait kompüterin aparat təminatına həsr olunub."), ...bodyPages()];
}
