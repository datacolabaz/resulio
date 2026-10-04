import { SingleFileUpload } from "@/components/FileUpload";
import { trpc } from "@/lib/trpc";
import type { UploadedFile } from "@/lib/uploadFile";

/** Single-file picker for a file already saved in syllabus content: name and size come from the stored file. */
export function StoredFileUpload({ fileId, name, onChange }: { fileId: string; name: string; onChange: (f: UploadedFile | null) => void }) {
  const info = trpc.teacher.syllabus.fileInfo.useQuery({ ids: [fileId] }, { enabled: !!fileId, staleTime: 10 * 60_000 });
  const stored = info.data?.find((f) => f.id === fileId);
  const value = fileId ? { fileId, name: name || stored?.name || "", size: stored?.size ?? 0, mimeType: stored?.mimeType ?? "" } : null;
  return <SingleFileUpload context="syllabus" value={value} onChange={onChange} />;
}
