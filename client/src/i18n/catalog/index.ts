import { admin } from "./admin";
import { app } from "./app";
import { builder } from "./builder";
import { common } from "./common";
import { format } from "./format";
import { site } from "./site";
import { student } from "./student";
import { syllabus } from "./syllabus";
import { syllabusLearn } from "./syllabusLearn";
import { teacher } from "./teacher";
import { teachingCategories } from "./teachingCategories";

/** Every domain catalog; the i18n test checks that no key is defined twice. */
export const domains = { common, format, app, teacher, builder, student, admin, teachingCategories, site, syllabus, syllabusLearn } as const;

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
} as const;
