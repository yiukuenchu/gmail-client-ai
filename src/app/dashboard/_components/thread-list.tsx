"use client";

import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "~/trpc/react";
import { formatDistanceToNow } from "date-fns";
import { StarIcon, MailIcon, MailOpenIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import Link from "next/link";
import { useIntersection } from "~/hooks/use-intersection";

interface ThreadListProps {
  labelId?: string;
  unreadOnly?: boolean;
  search?: string;
}

export function ThreadList({ labelId, unreadOnly, search }: ThreadListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = api.gmail.getThreads.useInfiniteQuery(
    {
      limit: 50,
      labelId,
      unreadOnly,
      search,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const intersection = useIntersection(loadMoreRef, {
    root: parentRef.current,
    rootMargin: "100px",
  });

  useEffect(() => {
    if (intersection?.isIntersecting && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [intersection?.isIntersecting, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const allThreads = data?.pages.flatMap((page) => page.threads) ?? [];

  const rowVirtualizer = useVirtualizer({
    count: allThreads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  const toggleStar = api.gmail.toggleStar.useMutation();

  const handleToggleStar = (e: React.MouseEvent, threadId: string, currentStarred: boolean) => {
    e.preventDefault();
    toggleStar.mutate({ threadId, starred: !currentStarred });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading messages...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-500">Failed to load messages</div>
      </div>
    );
  }

  if (allThreads.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">No messages found</div>
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualItem) => {
          const thread = allThreads[virtualItem.index];
          if (!thread) return null;

          const from = thread.messages[0]?.from ?? "Unknown";
          const fromName = from.split("<")[0]?.trim() ?? from;
          const labels = thread.labelThreads.map((lt) => lt.label);

          return (
            <Link
              key={thread.id}
              href={`/dashboard/thread/${thread.id}`}
              className="block"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <div
                className={cn(
                  "flex items-center gap-3 px-6 py-3 hover:bg-gray-50 border-b border-gray-100 transition-colors h-full",
                  thread.unread && "bg-white font-semibold"
                )}
              >
                <button
                  onClick={(e) => handleToggleStar(e, thread.id, thread.starred)}
                  className={cn(
                    "p-1 rounded hover:bg-gray-200 transition-colors",
                    thread.starred ? "text-yellow-500" : "text-gray-400"
                  )}
                >
                  <StarIcon className="w-4 h-4" fill={thread.starred ? "currentColor" : "none"} />
                </button>

                <div className="w-6">
                  {thread.unread ? (
                    <MailIcon className="w-5 h-5 text-blue-600" />
                  ) : (
                    <MailOpenIcon className="w-5 h-5 text-gray-400" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate", thread.unread && "text-gray-900")}>
                      {fromName}
                    </span>
                    {thread.messageCount > 1 && (
                      <span className="text-sm text-gray-500">({thread.messageCount})</span>
                    )}
                  </div>
                  <div className={cn("text-sm truncate", thread.unread ? "text-gray-800" : "text-gray-600")}>
                    {thread.subject}
                  </div>
                  <div className="text-sm text-gray-500 truncate">{thread.snippet}</div>
                </div>

                <div className="text-sm text-gray-500 whitespace-nowrap">
                  {formatDistanceToNow(thread.lastMessageDate, { addSuffix: true })}
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {hasNextPage && (
        <div ref={loadMoreRef} className="p-4 text-center">
          {isFetchingNextPage ? (
            <div className="text-gray-500">Loading more...</div>
          ) : null}
        </div>
      )}
    </div>
  );
}