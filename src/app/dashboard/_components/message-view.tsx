"use client";

import { useState, useEffect } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDownIcon, ChevronRightIcon, PaperclipIcon, DownloadIcon, ForwardIcon, ReplyIcon } from "lucide-react";
import { api } from "~/trpc/react";
import { cn } from "~/lib/utils";
import type { Message, Attachment } from "@prisma/client";

interface MessageViewProps {
  message: Message & {
    attachments: Attachment[];
  };
  isExpanded?: boolean;
  onForward?: (message: Message) => void;
  onReply?: (message: Message) => void;
}

export function MessageView({ message, isExpanded: initialExpanded = false, onForward, onReply }: MessageViewProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [contentLoaded, setContentLoaded] = useState(false);
  
  const { data: content, isLoading } = api.gmail.getMessageContent.useQuery(
    { messageId: message.id },
    { enabled: isExpanded && !contentLoaded }
  );

  useEffect(() => {
    if (content && !contentLoaded) {
      setContentLoaded(true);
    }
  }, [content, contentLoaded]);

  const fromName = message.from.split("<")[0]?.trim() || message.from;
  const fromEmail = message.from.match(/<(.+)>/)?.[1] || message.from;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Message Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-6 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex-shrink-0">
          {isExpanded ? (
            <ChevronDownIcon className="w-5 h-5 text-gray-400" />
          ) : (
            <ChevronRightIcon className="w-5 h-5 text-gray-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{fromName}</span>
            <span className="text-sm text-gray-500">&lt;{fromEmail}&gt;</span>
          </div>
          {!isExpanded && (
            <div className="text-sm text-gray-600 truncate mt-1">{message.snippet}</div>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm text-gray-500">
          {message.attachments.length > 0 && (
            <PaperclipIcon className="w-4 h-4" />
          )}
          <span>{formatDistanceToNow(message.date, { addSuffix: true })}</span>
        </div>
      </button>

      {/* Message Content */}
      {isExpanded && (
        <div className="border-t">
          <div className="px-6 py-4">
            <div className="text-sm text-gray-600 mb-2">
              <div>To: {message.to.join(", ")}</div>
              {message.cc.length > 0 && <div>Cc: {message.cc.join(", ")}</div>}
            </div>

            {isLoading ? (
              <div className="py-8 text-center text-gray-500">Loading message content...</div>
            ) : content?.html ? (
              <div className="email-content-container">
                <iframe
                  srcDoc={sanitizeHtml(content.html)}
                  className="w-full min-h-[200px] border-0"
                  sandbox="allow-same-origin"
                  style={{ resize: 'vertical' }}
                  onLoad={(e) => {
                    const iframe = e.target as HTMLIFrameElement;
                    if (iframe.contentDocument) {
                      // Auto-resize iframe to content height
                      const height = iframe.contentDocument.documentElement.scrollHeight;
                      iframe.style.height = `${Math.max(height, 200)}px`;
                    }
                  }}
                />
              </div>
            ) : content?.text ? (
              <div className="whitespace-pre-wrap text-gray-800">{content.text}</div>
            ) : (
              <div className="text-gray-500 italic">No content available</div>
            )}
          </div>

          {/* Attachments */}
          {message.attachments.length > 0 && (
            <div className="border-t px-6 py-4">
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                Attachments ({message.attachments.length})
              </h4>
              <div className="space-y-2">
                {message.attachments.map((attachment) => (
                  <AttachmentItem key={attachment.id} attachment={attachment} />
                ))}
              </div>
            </div>
          )}

          {/* Message Actions */}
          <div className="border-t px-6 py-3">
            <div className="flex items-center gap-2">
              <button 
                className="raycast-button gap-2 text-sm"
                onClick={() => onReply?.(message)}
              >
                <ReplyIcon className="w-4 h-4" />
                Reply
              </button>
              
              {onForward && (
                <button 
                  className="raycast-button gap-2 text-sm"
                  onClick={() => onForward(message)}
                >
                  <ForwardIcon className="w-4 h-4" />
                  Forward
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AttachmentItem({ attachment }: { attachment: Attachment }) {
  const { data: attachmentData } = api.gmail.getAttachmentUrl.useQuery({
    attachmentId: attachment.id,
  });

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const handleDownload = () => {
    if (attachmentData?.url) {
      window.open(attachmentData.url, "_blank");
    }
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
      <PaperclipIcon className="w-5 h-5 text-gray-400" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-gray-900 truncate">{attachment.filename}</div>
        <div className="text-xs text-gray-500">{formatFileSize(attachment.size)}</div>
      </div>
      <button
        onClick={handleDownload}
        disabled={!attachmentData?.url}
        className="p-2 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
        title="Download"
      >
        <DownloadIcon className="w-4 h-4" />
      </button>
    </div>
  );
}

// Enhanced HTML sanitization to prevent CSS interference
function sanitizeHtml(html: string): string {
  // Create a basic HTML document wrapper to isolate styles
  const sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // Remove style tags
    .replace(/style\s*=\s*"[^"]*"/gi, "") // Remove inline styles that might affect layout
    .replace(/style\s*=\s*'[^']*'/gi, "");

  // Wrap in a container that resets styles
  return `
    <html>
      <head>
        <style>
          body { 
            margin: 0; 
            padding: 16px; 
            font-family: system-ui, -apple-system, sans-serif;
            line-height: 1.5;
            color: #374151;
          }
          * { 
            max-width: 100% !important; 
          }
          img { 
            height: auto !important; 
          }
        </style>
      </head>
      <body>${sanitized}</body>
    </html>
  `;
}