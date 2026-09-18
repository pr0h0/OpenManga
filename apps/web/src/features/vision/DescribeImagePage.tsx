import { PageHeader } from "../../components/ui.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { DescribeImage } from "./DescribeImage.tsx";

export function DescribeImagePage() {
  const projectId = useProjectId();
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Describe an image"
        subtitle="Upload a reference — a frame from a video, a page you like — and turn what it looks like into a style, a character or a location you can generate from."
      />
      <DescribeImage projectId={projectId} />
    </div>
  );
}
