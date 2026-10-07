import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { get } from "../../api/client.ts";
import { fmt } from "../../components/ui.tsx";
import { storageKeys } from "./StorageTab.tsx";

type Pending = { files: number; bytes: number; overLimitBytes: number } | null;

/**
 * The storage policy's warning for administrators, on every page: files waiting for approval to be deleted, or a size
 * limit nothing expendable can meet. It has no close button; it goes when the policy's state is resolved.
 */
export function StorageAlert() {
  const q = useQuery({
    queryKey: storageKeys.alert,
    queryFn: () => get<{ pending: Pending }>("/admin/storage/alert"),
    refetchInterval: 60_000,
  });
  const p = q.data?.pending;
  if (!p || (!p.files && !p.overLimitBytes)) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <TriangleAlert className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {p.files > 0 ? (
          <>
            Storage policy:{" "}
            <strong>
              {p.files} file(s), {fmt.bytes(p.bytes)}
            </strong>{" "}
            are due for deletion and wait for your approval.
          </>
        ) : null}
        {p.overLimitBytes > 0 && (
          <> Storage is {fmt.bytes(p.overLimitBytes)} over the limit even without every expendable file.</>
        )}
      </span>
      <Link to="/admin" search={{ tab: "storage" }} className="btn-secondary px-2 py-0.5 text-xs">
        Review
      </Link>
    </div>
  );
}
