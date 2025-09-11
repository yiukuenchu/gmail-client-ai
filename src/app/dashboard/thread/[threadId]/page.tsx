"use client";

import { useParams, useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { MessageView } from "../../_components/message-view";
import { ComposeReply } from "../../_components/compose-reply";
import { ArrowLeftIcon, StarIcon, TrashIcon, ArchiveIcon } from "lucide-react";
import { cn } from "~/lib/utils";

export default function ThreadPage() {
  const params = useParams();
  const router = useRouter();
  const threadId = params.threadId as string;

  const { data: thread, isLoading, error } = api.gmail.getThread.useQuery({ threadId });
  const utils = api.useUtils();
  const toggleStar = api.gmail.toggleStar.useMutation({
    onMutate: async ({ threadId, starred }) => {
      // Cancel outgoing refetches
      await utils.gmail.getThread.cancel({ threadId });

      // Snapshot previous value
      const previousThread = utils.gmail.getThread.getData({ threadId });

      // Optimistically update
      utils.gmail.getThread.setData({ threadId }, (old) => {
        if (!old) return old;
        return { ...old, starred };
      });

      return { previousThread };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousThread) {
        utils.gmail.getThread.setData({ threadId: variables.threadId }, context.previousThread);
      }
    },
    onSettled: () => {
      // Invalidate all related queries to ensure consistency across all views
      void utils.gmail.getThread.invalidate({ threadId });
      void utils.gmail.getThreads.invalidate(); // This invalidates ALL getThreads queries
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading thread...</div>
      </div>
    );
  }

  if (error || !thread) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-500">Failed to load thread</div>
      </div>
    );
  }

  const handleToggleStar = () => {
    if (!thread) return;
    toggleStar.mutate({ threadId: thread.id, starred: !thread.starred });
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Thread Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="Back"
            >
              <ArrowLeftIcon className="w-5 h-5" />
            </button>
            
            <h1 className="text-xl font-semibold text-gray-900">{thread.subject}</h1>
            
            <div className="flex items-center gap-2">
              {thread.labelThreads.map((lt) => (
                <span
                  key={lt.label.id}
                  className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-700"
                  style={{
                    backgroundColor: lt.label.color ? `${lt.label.color}20` : undefined,
                    color: lt.label.color ?? undefined,
                  }}
                >
                  {lt.label.name}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleStar}
              className={cn(
                "p-2 hover:bg-gray-100 rounded-lg transition-colors",
                thread.starred ? "text-yellow-500" : "text-gray-400"
              )}
              title={thread.starred ? "Unstar" : "Star"}
            >
              <StarIcon className="w-5 h-5" fill={thread.starred ? "currentColor" : "none"} />
            </button>
            
            <button
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-600"
              title="Archive"
            >
              <ArchiveIcon className="w-5 h-5" />
            </button>
            
            <button
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-600"
              title="Delete"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {thread.messages.map((message, index) => (
          <MessageView
            key={message.id}
            message={message}
            isExpanded={index === thread.messages.length - 1}
          />
        ))}
      </div>

      {/* Reply Composer */}
      <div className="border-t bg-white">
        <ComposeReply threadId={thread.id} />
      </div>
    </div>
  );
}