import { admin } from "./admin";
import { app } from "./app";
import { builder } from "./builder";
import { common } from "./common";
import { format } from "./format";
import { student } from "./student";
import { teacher } from "./teacher";

/** Every domain catalog; the i18n test checks that no key is defined twice. */
export const domains = { common, format, app, teacher, builder, student, admin } as const;

export const catalog = { ...common, ...format, ...app, ...teacher, ...builder, ...student, ...admin } as const;
