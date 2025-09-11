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
  showMetrics?: boolean;
}

export function ThreadList({ labelId, unreadOnly, search, showMetrics = false }: ThreadListProps) {
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

  const utils = api.useUtils();
  const toggleStar = api.gmail.toggleStar.useMutation({
    onMutate: async ({ threadId, starred }) => {
      // Cancel any outgoing refetches
      await utils.gmail.getThreads.cancel();

      // Snapshot the previous value
      const previousThreads = utils.gmail.getThreads.getData();

      // Optimistically update all relevant caches
      const updateCache = (data: any) => {
        if (!data) return data;
        
        return {
          ...data,
          pages: data.pages.map((page: any) => ({
            ...page,
            threads: page.threads.map((thread: any) =>
              thread.id === threadId
                ? { ...thread, starred }
                : thread
            )
          }))
        };
      };

      // Update current view cache
      utils.gmail.getThreads.setInfiniteData(
        { labelId, unreadOnly, search },
        updateCache
      );

      // Update starred page cache specifically
      utils.gmail.getThreads.setInfiniteData(
        { labelId: "STARRED", unreadOnly: false, search: undefined },
        updateCache
      );

      // Update inbox cache if different
      if (labelId !== undefined) {
        utils.gmail.getThreads.setInfiniteData(
          { labelId: undefined, unreadOnly: false, search: undefined },
          updateCache
        );
      }

      return { previousThreads };
    },
    onError: (err, variables, context) => {
      // Rollback is handled by the automatic invalidation
      // The invalidation will refetch fresh data from the server
    },
    onSettled: () => {
      // Invalidate all thread queries to ensure consistency across all views
      void utils.gmail.getThreads.invalidate();
    },
  });

  const handleToggleStar = (e: React.MouseEvent, threadId: string, currentStarred: boolean) => {
    e.preventDefault();
    toggleStar.mutate({ threadId, starred: !currentStarred });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div style={{ color: 'var(--color-raycast-text-secondary)' }}>
          Loading messages...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div style={{ color: 'var(--color-raycast-error)' }}>
          Failed to load messages
        </div>
      </div>
    );
  }

  if (allThreads.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div style={{ color: 'var(--color-raycast-text-secondary)' }}>
          No messages found
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {showMetrics && (
        <div className="px-6 py-3 text-sm font-medium" style={{ 
          backgroundColor: 'var(--color-raycast-bg-tertiary)', 
          borderBottom: '1px solid var(--color-raycast-border-light)', 
          color: 'var(--color-raycast-text-secondary)' 
        }}>
          <span>
            {allThreads.length} threads loaded
            {hasNextPage && " • Loading more as you scroll"}
          </span>
        </div>
      )}
      
      <div ref={parentRef} className="flex-1 overflow-auto p-4">
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
                padding: '0 0 8px 0', // Add padding for card spacing
              }}
            >
              <div
                className={cn(
                  "raycast-card flex items-center gap-3 px-4 py-3 h-full",
                  thread.unread && "font-medium"
                )}
                style={{
                  backgroundColor: thread.unread 
                    ? 'var(--color-raycast-selected)' 
                    : 'var(--color-raycast-surface)',
                  height: 'calc(100% - 8px)', // Account for card spacing
                }}
              >
                <button
                  onClick={(e) => handleToggleStar(e, thread.id, thread.starred)}
                  className={cn(
                    "p-1 rounded-md transition-all hover:scale-110",
                    thread.starred ? "text-yellow-500" : ""
                  )}
                  style={{
                    color: thread.starred 
                      ? '#f59e0b' 
                      : 'var(--color-raycast-text-tertiary)',
                  }}
                >
                  <StarIcon className="w-4 h-4" fill={thread.starred ? "currentColor" : "none"} />
                </button>

                <div className="w-6">
                  {thread.unread ? (
                    <MailIcon className="w-5 h-5" style={{ color: 'var(--color-raycast-accent)' }} />
                  ) : (
                    <MailOpenIcon className="w-5 h-5" style={{ color: 'var(--color-raycast-text-tertiary)' }} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span 
                      className="truncate font-medium text-sm"
                      style={{ 
                        color: thread.unread 
                          ? 'var(--color-raycast-text)' 
                          : 'var(--color-raycast-text-secondary)' 
                      }}
                    >
                      {fromName}
                    </span>
                    {thread.messageCount > 1 && (
                      <span 
                        className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                        style={{ 
                          backgroundColor: 'var(--color-raycast-bg-tertiary)', 
                          color: 'var(--color-raycast-text-secondary)' 
                        }}
                      >
                        {thread.messageCount}
                      </span>
                    )}
                  </div>
                  <div 
                    className="text-sm truncate mb-1 font-medium"
                    style={{ 
                      color: thread.unread 
                        ? 'var(--color-raycast-text)' 
                        : 'var(--color-raycast-text-secondary)' 
                    }}
                  >
                    {thread.subject}
                  </div>
                  <div 
                    className="text-xs truncate"
                    style={{ color: 'var(--color-raycast-text-tertiary)' }}
                  >
                    {thread.snippet}
                  </div>
                </div>

                <div 
                  className="text-xs whitespace-nowrap font-medium"
                  style={{ color: 'var(--color-raycast-text-tertiary)' }}
                >
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
              <div style={{ color: 'var(--color-raycast-text-secondary)' }}>
                Loading more...
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}