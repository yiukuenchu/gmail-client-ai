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

  // Helper function to determine if a navigation item should be active
  const isItemActive = (href: string) => {
    if (pathname === href) return true;
    
    // Special case for inbox: make it active for thread detail pages that don't belong to other sections
    if (href === "/dashboard" && pathname.startsWith("/dashboard/thread/")) {
      return true;
    }
    
    return false;
  };

  return (
    <div className="w-64 flex flex-col min-h-0 flex-shrink-0" style={{ 
      backgroundColor: 'var(--color-raycast-surface)', 
      borderRight: '1px solid var(--color-raycast-border-light)' 
    }}>
      <div className="p-4">
        <button
          onClick={handleSync}
          disabled={syncMailbox.isPending || syncStatus?.currentJob?.status === "RUNNING"}
          className="raycast-button primary w-full gap-2"
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

      <nav className="flex-1 px-3 pb-4 space-y-1 overflow-y-auto min-h-0">
        {defaultLabels.map((label) => {
          const Icon = label.icon;
          const isActive = isItemActive(label.href);
          
          return (
            <Link
              key={label.id}
              href={label.href}
              className={cn(
                "raycast-list-item gap-3 text-sm font-medium",
                isActive && "active"
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
              <h3 className="text-xs font-semibold uppercase" style={{ color: 'var(--color-raycast-text-secondary)' }}>
                Labels
              </h3>
            </div>
            {userLabels.map((label) => {
              const href = `/dashboard/label/${label.id}`;
              const isActive = isItemActive(href);
              
              return (
                <Link
                  key={label.id}
                  href={href}
                  className={cn(
                    "raycast-list-item gap-3 text-sm font-medium",
                    isActive && "active"
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
        <div className="px-4 py-2 text-xs" style={{ 
          color: 'var(--color-raycast-text-tertiary)', 
          borderTop: '1px solid var(--color-raycast-border-light)' 
        }}>
          Last synced: {new Date(syncStatus.lastSyncedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}