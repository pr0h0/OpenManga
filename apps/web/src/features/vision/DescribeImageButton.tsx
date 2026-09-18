import type { ImageAspectKey, ImageDescription } from "@openmanga/schemas";
import { ScanEye } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../components/ui.tsx";
import { DescribeImage } from "./DescribeImage.tsx";

/**
 * "Fill this from a reference image" for an editor that already has a form: opens the describe flow scoped to
 * one aspect, and hands the result back rather than creating anything of its own.
 */
export function DescribeImageButton({
  projectId,
  aspect,
  label = "From image",
  title,
  onUse,
  className,
}: {
  projectId: string;
  aspect: ImageAspectKey;
  label?: string;
  title: string;
  onUse: (description: ImageDescription) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className ?? "btn-secondary"} onClick={() => setOpen(true)}>
        <ScanEye className="size-4" /> {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} wide="xl">
        <DescribeImage
          projectId={projectId}
          only={[aspect]}
          onUse={(d) => {
            onUse(d);
            setOpen(false);
          }}
        />
      </Modal>
    </>
  );
}
