import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/messages";
import { Camera as CameraIcon, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Longest side a captured photo is downscaled to before upload -- keeps phone-camera shots well
 *  under the server's 8MB-per-file cap (server/modules/files.ts) and the vision model's
 *  token/latency cost down, without losing legibility for a photographed page of text. */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

type Shot = { id: string; blob: Blob; previewUrl: string };

/**
 * A custom in-app multi-shot camera (the user's confirmed design choice over the simpler
 * native-camera-app-via-file-input route): opens a live preview, lets the teacher take several
 * photos in a row -- each previewed and individually removable -- then hands all of them back at
 * once as plain `File`s. The caller feeds those into the existing `uploadFile(file, "ai-source")`
 * pipeline unchanged (see `AiSourcePicker`), so this component only ever produces files, never
 * talks to the server itself.
 */
export function CameraCapture({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: (files: File[]) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [error, setError] = useState(false);
  const [facing, setFacing] = useState<"environment" | "user">("environment");

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  // Opens (and reopens, on flip) the camera stream while the dialog is open; always torn down on
  // close/unmount so a backgrounded tab never keeps the camera light on.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(false);
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [open, facing]);

  // Shots carry their own object URLs for the thumbnail strip; closing without "Bitir" (done)
  // must still revoke them so repeated open/close cycles don't leak blob URLs.
  useEffect(() => {
    if (open) return;
    setShots((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.previewUrl));
      return [];
    });
  }, [open]);

  const shoot = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setShots((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, blob, previewUrl: URL.createObjectURL(blob) }]);
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  };

  const removeShot = (id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  };

  const finish = () => {
    const files = shots.map((s, i) => new File([s.blob], `camera-${Date.now()}-${i + 1}.jpg`, { type: "image/jpeg" }));
    shots.forEach((s) => URL.revokeObjectURL(s.previewUrl));
    setShots([]);
    onOpenChange(false);
    if (files.length) onDone(files);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) stopStream();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{t("builder.aiCameraTitle")}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          {error ? (
            <p className="text-sm text-destructive">{t("builder.aiCameraError")}</p>
          ) : (
            <div className="overflow-hidden rounded-lg bg-sidebar">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live camera preview, nothing to caption */}
              <video ref={videoRef} autoPlay playsInline muted className="aspect-[3/4] w-full object-cover" />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>
              <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
              {t("builder.aiCameraFlip")}
            </Button>
            <Button type="button" disabled={error} onClick={shoot}>
              <CameraIcon className="mr-1 h-4 w-4" aria-hidden />
              {t("builder.aiCameraShoot")}
            </Button>
            <span className="text-sm text-muted-foreground">{t("builder.aiCameraCount", { count: shots.length })}</span>
          </div>
          {shots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {shots.map((s, i) => (
                <div key={s.id} className="relative h-20 w-16 shrink-0 overflow-hidden rounded-md border border-border">
                  <img src={s.previewUrl} alt="" className="h-full w-full object-cover" />
                  <span className="absolute bottom-0 left-0 rounded-tr-md bg-background/80 px-1 text-[10px]">{i + 1}</span>
                  <button
                    type="button"
                    aria-label={t("builder.aiCameraRemoveShot")}
                    onClick={() => removeShot(s.id)}
                    className="absolute top-0 right-0 rounded-bl-md bg-background/80 p-0.5"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="button" disabled={!shots.length} onClick={finish}>{t("builder.aiCameraDone", { count: shots.length })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
