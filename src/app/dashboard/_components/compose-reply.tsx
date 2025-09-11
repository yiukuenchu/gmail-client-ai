"use client";

import { useState, useRef } from "react";
import { api } from "~/trpc/react";
import { SendIcon, PaperclipIcon, SparklesIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";

interface ComposeReplyProps {
  threadId: string;
}

export function ComposeReply({ threadId }: ComposeReplyProps) {
  const [isComposing, setIsComposing] = useState(false);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const utils = api.useUtils();
  const sendReply = api.gmail.sendReply.useMutation({
    onSuccess: (data) => {
      // Invalidate all relevant caches to show the sent message immediately
      void utils.gmail.getThread.invalidate({ threadId });
      void utils.gmail.getThreads.invalidate(); // This invalidates ALL getThreads queries including Sent page
      
      console.log("Send successful, optimistic message:", data.optimisticMessage);
    },
    onError: (error) => {
      console.error("Send failed:", error);
      // Invalidate caches to remove any optimistic updates
      void utils.gmail.getThread.invalidate({ threadId });
      void utils.gmail.getThreads.invalidate();
    },
  });
  const generateAIDraft = api.gmail.generateAIDraft.useMutation();

  const handleSend = async () => {
    if (!to.trim() || !content.trim()) return;

    try {
      await sendReply.mutateAsync({
        threadId,
        to: to.split(",").map(e => e.trim()),
        cc: cc ? cc.split(",").map(e => e.trim()) : [],
        subject,
        content,
        attachmentKeys: [], // TODO: Upload attachments first
      });

      // Reset form only after successful send
      setIsComposing(false);
      setTo("");
      setCc("");
      setSubject("");
      setContent("");
      setAttachments([]);
    } catch (error) {
      // Error is already handled by mutation onError callback
      // Keep form open so user can retry
    }
  };

  const handleAIDraft = async () => {
    try {
      const result = await generateAIDraft.mutateAsync({ threadId });
      setContent(result.draft);
    } catch (error) {
      console.error("Failed to generate AI draft:", error);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setAttachments(prev => [...prev, ...files]);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  if (!isComposing) {
    return (
      <div className="p-4">
        <button
          onClick={() => setIsComposing(true)}
          className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
        >
          <span className="text-gray-600">Click here to reply...</span>
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="space-y-2">
        <div className="flex gap-2">
          <label className="text-sm font-medium text-gray-700 w-12">To:</label>
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Recipients"
            className="flex-1 px-3 py-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-2">
          <label className="text-sm font-medium text-gray-700 w-12">Cc:</label>
          <input
            type="text"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="Cc recipients (optional)"
            className="flex-1 px-3 py-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-2">
          <label className="text-sm font-medium text-gray-700 w-12">Subject:</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 px-3 py-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="relative">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Compose your reply..."
          rows={6}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
        
        <button
          onClick={handleAIDraft}
          disabled={generateAIDraft.isPending}
          className={cn(
            "absolute top-3 right-3 px-3 py-1 text-sm rounded-lg flex items-center gap-2 transition-colors",
            "bg-purple-100 hover:bg-purple-200 text-purple-700 disabled:opacity-50"
          )}
        >
          <SparklesIcon className="w-4 h-4" />
          {generateAIDraft.isPending ? "Generating..." : "Draft with AI"}
        </button>
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="space-y-2">
          {attachments.map((file, index) => (
            <div key={index} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
              <PaperclipIcon className="w-4 h-4 text-gray-400" />
              <span className="flex-1 text-sm text-gray-700 truncate">{file.name}</span>
              <button
                onClick={() => removeAttachment(index)}
                className="p-1 hover:bg-gray-200 rounded transition-colors"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSend}
            disabled={sendReply.isPending || !to.trim() || !content.trim()}
            className={cn(
              "px-4 py-2 rounded-lg flex items-center gap-2 transition-colors",
              "bg-blue-600 hover:bg-blue-700 text-white disabled:bg-gray-300"
            )}
          >
            <SendIcon className="w-4 h-4" />
            {sendReply.isPending ? "Sending..." : "Send"}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="Attach files"
          >
            <PaperclipIcon className="w-5 h-5" />
          </button>
        </div>

        <button
          onClick={() => {
            setIsComposing(false);
            setTo("");
            setCc("");
            setSubject("");
            setContent("");
            setAttachments([]);
          }}
          className="text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}