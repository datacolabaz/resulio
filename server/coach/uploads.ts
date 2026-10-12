import { extensionOf } from "../modules/files";
import { completeUpload, abortUpload, openUploadSession, partUrls } from "../materials/directUpload";
import { assertUploadAllowed, COACH_FILE_TYPES, coachWorkspaceId } from "./materials";

/**
 * Large coach files go from the browser straight to R2, through the same signed-URL sessions as
 * teacher materials (server/materials/directUpload.ts), scoped to the student's private space
 * `coach-u<id>`. The file stays private; type, size and page count are checked again when the
 * material is created and processed (the server never saw these bytes on the way in).
 */

const scopeOf = (studentId: number) => ({ workspaceId: coachWorkspaceId(studentId), userId: studentId });

export async function startCoachUpload(studentId: number, input: { fileName: string; sizeBytes: number }) {
  await assertUploadAllowed(studentId, input.fileName, input.sizeBytes);
  return openUploadSession(scopeOf(studentId), { fileName: input.fileName, sizeBytes: input.sizeBytes, mimeType: COACH_FILE_TYPES[extensionOf(input.fileName)] });
}

export const coachUploadPartUrls = (studentId: number, sessionId: string, partNumbers: number[]) => partUrls(scopeOf(studentId), sessionId, partNumbers);

export const completeCoachUpload = (studentId: number, sessionId: string) => completeUpload(scopeOf(studentId), sessionId, { isPublic: false });

export const abortCoachUpload = (studentId: number, sessionId: string) => abortUpload(scopeOf(studentId), sessionId);
