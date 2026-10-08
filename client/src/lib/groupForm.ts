import { GROUP_LEVELS, groupFieldsForType, levelKeyOf, type GroupLevel, type GroupType, type GroupTypeFields } from "@shared/groupType";

/** "" = not chosen; "OTHER" = the teacher types their own level (existing levels are free text). */
export type LevelChoice = GroupLevel | "" | "OTHER";

/**
 * The type-dependent part of the group form. Both types' values stay in the draft while the
 * teacher switches back and forth; only the chosen type's fields are sent (typePayload).
 */
export interface GroupTypeDraft {
  groupType: GroupType;
  subject: string;
  grade: string;
  levelChoice: LevelChoice;
  levelText: string;
}

export function levelChoiceOf(level: string): Pick<GroupTypeDraft, "levelChoice" | "levelText"> {
  const trimmed = level.trim();
  if (!trimmed) return { levelChoice: "", levelText: "" };
  const key = levelKeyOf(trimmed);
  return key ? { levelChoice: key, levelText: "" } : { levelChoice: "OTHER", levelText: trimmed };
}

export function typeDraftOf(group: { groupType: GroupType; subject: string; grade: string; level: string } | undefined, defaultType: GroupType): GroupTypeDraft {
  if (!group) return { groupType: defaultType, subject: "", grade: "", levelChoice: "", levelText: "" };
  return { groupType: group.groupType, subject: group.subject, grade: group.grade, ...levelChoiceOf(group.level) };
}

export function typePayload(d: GroupTypeDraft): GroupTypeFields {
  const level = d.levelChoice === "OTHER" ? d.levelText : d.levelChoice;
  return groupFieldsForType({ groupType: d.groupType, subject: d.subject, grade: d.grade, level });
}

/** Label keys of the two type-dependent fields, in form order. */
export function typeFieldKeys(groupType: GroupType) {
  return groupType === "SCHOOL"
    ? ({ subject: "groups.field.subject", subjectPlaceholder: "groups.field.subjectPlaceholder", second: "groups.field.class" } as const)
    : ({ subject: "groups.field.direction", subjectPlaceholder: "groups.field.directionPlaceholder", second: "groups.field.level" } as const);
}

export const LEVEL_OPTIONS: readonly GroupLevel[] = GROUP_LEVELS;
