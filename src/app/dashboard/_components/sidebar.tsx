"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "~/trpc/react";
import { 
  InboxIcon, 
  StarIcon, 
  SendIcon, 
  FileTextIcon,
  TrashIcon,
  TagIcon,
  RefreshCwIcon,
  MailIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";

const defaultLabels = [
  { id: "inbox", name: "Inbox", icon: InboxIcon, href: "/dashboard" },
  { id: "all", name: "All Mail", icon: MailIcon, href: "/dashboard/all" },
  { id: "starred", name: "Starred", icon: StarIcon, href: "/dashboard/starred" },
  { id: "sent", name: "Sent", icon: SendIcon, href: "/dashboard/sent" },
  { id: "drafts", name: "Drafts", icon: FileTextIcon, href: "/dashboard/drafts" },
  { id: "trash", name: "Trash", icon: TrashIcon, href: "/dashboard/trash" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: labels } = api.gmail.getLabels.useQuery();
  const syncMailbox = api.gmail.syncMailbox.useMutation();
  const { data: syncStatus } = api.gmail.getSyncStatus.useQuery();

  const handleSync = () => {
    syncMailbox.mutate();
  };

  const userLabels = labels?.filter(label => label.type === "USER") ?? [];

  return (
    <div className="w-64 bg-white border-r border-gray-200 flex flex-col">
      <div className="p-4">
        <button
          onClick={handleSync}
          disabled={syncMailbox.isPending || syncStatus?.currentJob?.status === "RUNNING"}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg px-4 py-2 flex items-center justify-center gap-2 transition-colors"
        >
          <RefreshCwIcon className={cn(
            "w-4 h-4",
            (syncMailbox.isPending || syncStatus?.currentJob?.status === "RUNNING") && "animate-spin"
          )} />
          {syncStatus?.currentJob?.status === "RUNNING" 
            ? `Syncing... ${Math.round(syncStatus.currentJob.progress)}%`
            : "Sync Mail"
          }
        </button>
      </div>

      <nav className="flex-1 px-2 pb-4 space-y-1 overflow-y-auto">
        {defaultLabels.map((label) => {
          const Icon = label.icon;
          const isActive = pathname === label.href;
          
          return (
            <Link
              key={label.id}
              href={label.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-700 hover:bg-gray-100"
              )}
            >
              <Icon className="w-5 h-5" />
              {label.name}
            </Link>
          );
        })}

        {userLabels.length > 0 && (
          <>
            <div className="pt-4 pb-2 px-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase">Labels</h3>
            </div>
            {userLabels.map((label) => {
              const href = `/dashboard/label/${label.id}`;
              const isActive = pathname === href;
              
              return (
                <Link
                  key={label.id}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-700 hover:bg-gray-100"
                  )}
                >
                  <TagIcon className="w-5 h-5" style={{ color: label.color ?? undefined }} />
                  {label.name}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {syncStatus?.lastSyncedAt && (
        <div className="px-4 py-2 text-xs text-gray-500 border-t">
          Last synced: {new Date(syncStatus.lastSyncedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}