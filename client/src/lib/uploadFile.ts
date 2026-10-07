import { API_BASE } from "@/const";
import { SHARE_SOURCE_PARAM, type ShareCampaign, type ShareChannel } from "@shared/shareTracking";

export interface UploadedFile {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
}

export class UploadError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export type UploadContext = "task-attachment" | "material" | "submission" | "syllabus" | "question-import";

/** Uploads one file to the server's blob store (see server/_core/files.ts); `taskId` is required
 *  for "submission" uploads so the server can verify the student may actually submit to that task. */
export async function uploadFile(file: File, context: UploadContext, opts?: { taskId?: string }): Promise<UploadedFile> {
  const form = new FormData();
  form.append("file", file);
  form.append("context", context);
  if (opts?.taskId) form.append("taskId", opts.taskId);

  const res = await fetch(`${API_BASE}/api/files/upload`, { method: "POST", credentials: "include", body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new UploadError(body?.error ?? "UPLOAD_FAILED");
  }
  const data = (await res.json()) as { id: string; name: string; size: number; mimeType: string };
  return { fileId: data.id, name: data.name, size: data.size, mimeType: data.mimeType };
}

export function fileDownloadUrl(fileId: string): string {
  return `${API_BASE}/api/files/${fileId}`;
}

/** Download link from a public share page: the server records the share-link "downloaded" event itself when it serves the file. */
export function sharedFileDownloadUrl(
  fileId: string,
  share: { targetType: "TASK" | "MATERIAL"; shareCode: string; channel?: ShareChannel; campaign?: ShareCampaign; visitorId: string },
): string {
  const params = new URLSearchParams({ share: share.targetType, code: share.shareCode, vid: share.visitorId });
  if (share.channel) params.set("src", SHARE_SOURCE_PARAM[share.channel]);
  if (share.campaign) params.set("campaign", share.campaign);
  return `${fileDownloadUrl(fileId)}?${params.toString()}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
