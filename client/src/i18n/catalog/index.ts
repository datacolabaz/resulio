import { admin } from "./admin";
import { app } from "./app";
import { builder } from "./builder";
import { common } from "./common";
import { format } from "./format";
import { publishPlain } from "./publishPlain";
import { questionBank } from "./questionBank";
import { site } from "./site";
import { student } from "./student";
import { syllabus } from "./syllabus";
import { syllabusAnalytics } from "./syllabusAnalytics";
import { syllabusImport } from "./syllabusImport";
import { syllabusLearn } from "./syllabusLearn";
import { syllabusUx } from "./syllabusUx";
import { teacher } from "./teacher";
import { teachingCategories } from "./teachingCategories";

/** Every domain catalog; the i18n test checks that no key is defined twice. */
export const domains = { common, format, app, teacher, builder, student, admin, teachingCategories, site, syllabus, syllabusLearn, syllabusAnalytics, syllabusUx, syllabusImport, questionBank, publishPlain } as const;

export const catalog = {
  ...common,
  ...format,
  ...app,
  ...teacher,
  ...builder,
  ...student,
  ...admin,
  ...teachingCategories,
  ...site,
  ...syllabus,
  ...syllabusLearn,
  ...syllabusAnalytics,
  ...syllabusUx,
  ...syllabusImport,
  ...questionBank,
  ...publishPlain,
} as const;
