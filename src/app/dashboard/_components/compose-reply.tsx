"use client";

import { useState, useRef, forwardRef, useImperativeHandle } from "react";
import { api } from "~/trpc/react";
import { SendIcon, PaperclipIcon, SparklesIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { Message } from "@prisma/client";

interface ComposeReplyProps {
  threadId: string;
}

export interface ComposeReplyHandle {
  startReply: (message: Message) => void;
}

export const ComposeReply = forwardRef<ComposeReplyHandle, ComposeReplyProps>(({ threadId }, ref) => {
  const [isComposing, setIsComposing] = useState(false);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploadedAttachments, setUploadedAttachments] = useState<{id: string, s3Key: string, filename: string}[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composeRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    startReply: (message: Message) => {
      setIsComposing(true);
      setTo(message.from);
      setSubject(message.subject.startsWith('Re: ') ? message.subject : `Re: ${message.subject}`);
      setContent('');
      
      // Scroll to compose area after state updates
      setTimeout(() => {
        composeRef.current?.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start' 
        });
      }, 100);
    }
  }));

  const utils = api.useUtils();
  const uploadAttachment = api.gmail.uploadAttachment.useMutation();
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
      // Clean and validate email addresses
      const cleanEmails = (emailStr: string) => {
        return emailStr
          .split(",")
          .map(e => e.trim())
          .filter(e => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      };

      const toEmails = cleanEmails(to);
      const ccEmails = cc ? cleanEmails(cc) : [];

      if (toEmails.length === 0) {
        throw new Error("Please enter at least one valid email address");
      }

      // Upload any pending attachments first
      const attachmentKeys: string[] = [];
      const attachmentMetadata: Array<{s3Key: string, filename: string, contentType: string, size: number}> = [];
      
      for (const file of attachments) {
        // Check if already uploaded
        const existingUpload = uploadedAttachments.find(u => u.filename === file.name);
        if (existingUpload) {
          attachmentKeys.push(existingUpload.s3Key);
          attachmentMetadata.push({
            s3Key: existingUpload.s3Key,
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
          });
          continue;
        }

        // Convert file to base64
        const fileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.split(',')[1]; // Remove data:type;base64, prefix
            if (base64) {
              resolve(base64);
            } else {
              reject(new Error('Failed to convert file to base64'));
            }
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });

        // Upload to S3
        const uploadResult = await uploadAttachment.mutateAsync({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          fileData,
          size: file.size,
        });

        attachmentKeys.push(uploadResult.s3Key);
        attachmentMetadata.push({
          s3Key: uploadResult.s3Key,
          filename: uploadResult.filename,
          contentType: uploadResult.contentType,
          size: uploadResult.size,
        });
        
        // Track uploaded attachment
        setUploadedAttachments(prev => [...prev, {
          id: uploadResult.attachmentId,
          s3Key: uploadResult.s3Key,
          filename: uploadResult.filename,
        }]);
      }

      await sendReply.mutateAsync({
        threadId,
        to: toEmails,
        cc: ccEmails,
        subject,
        content,
        attachmentKeys,
        attachments: attachmentMetadata,
      });

      // Reset form only after successful send
      setIsComposing(false);
      setTo("");
      setCc("");
      setSubject("");
      setContent("");
      setAttachments([]);
      setUploadedAttachments([]);
    } catch (error) {
      console.error("Send failed:", error);
      alert(error instanceof Error ? error.message : "Failed to send email");
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
    const fileToRemove = attachments[index];
    setAttachments(prev => prev.filter((_, i) => i !== index));
    
    // Also remove from uploaded attachments if it was uploaded
    if (fileToRemove) {
      setUploadedAttachments(prev => prev.filter(u => u.filename !== fileToRemove.name));
    }
  };

  if (!isComposing) {
    return (
      <div ref={composeRef} className="p-6">
        <button
          onClick={() => {
            setIsComposing(true);
            // Scroll to compose area when manually clicking
            setTimeout(() => {
              composeRef.current?.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'start' 
              });
            }, 100);
          }}
          className="raycast-card w-full text-left px-4 py-3"
          style={{
            backgroundColor: 'var(--color-raycast-bg-tertiary)',
            border: '1px dashed var(--color-raycast-border)',
          }}
        >
          <span style={{ color: 'var(--color-raycast-text-secondary)' }}>
            Click here to reply...
          </span>
        </button>
      </div>
    );
  }

  return (
    <div ref={composeRef} className="raycast-card m-6 p-6 space-y-4">
      <div className="space-y-3">
        <div className="flex gap-3 items-center">
          <label className="text-sm font-medium w-16" style={{ color: 'var(--color-raycast-text-secondary)' }}>
            To:
          </label>
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Recipients"
            className="raycast-input flex-1"
          />
        </div>

        <div className="flex gap-3 items-center">
          <label className="text-sm font-medium w-16" style={{ color: 'var(--color-raycast-text-secondary)' }}>
            Cc:
          </label>
          <input
            type="text"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="Cc recipients (optional)"
            className="raycast-input flex-1"
          />
        </div>

        <div className="flex gap-3 items-center">
          <label className="text-sm font-medium w-16" style={{ color: 'var(--color-raycast-text-secondary)' }}>
            Subject:
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="raycast-input flex-1"
          />
        </div>
      </div>

      <div className="relative">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Compose your reply..."
          rows={6}
          className="raycast-input resize-none"
          style={{ minHeight: '120px' }}
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
            <div 
              key={index} 
              className="flex items-center gap-2 p-2 rounded-lg"
              style={{ backgroundColor: 'var(--color-raycast-bg-tertiary)' }}
            >
              <PaperclipIcon className="w-4 h-4" style={{ color: 'var(--color-raycast-text-tertiary)' }} />
              <span className="flex-1 text-sm truncate" style={{ color: 'var(--color-raycast-text)' }}>
                {file.name}
              </span>
              <button
                onClick={() => removeAttachment(index)}
                className="p-1 rounded transition-all hover:scale-105"
                style={{ 
                  backgroundColor: 'var(--color-raycast-surface)',
                  color: 'var(--color-raycast-text-secondary)'
                }}
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
            disabled={sendReply.isPending || uploadAttachment.isPending || !to.trim() || !content.trim()}
            className="raycast-button primary gap-2 disabled:opacity-50"
          >
            <SendIcon className="w-4 h-4" />
            {uploadAttachment.isPending ? "Uploading..." : sendReply.isPending ? "Sending..." : "Send"}
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
            className="raycast-button p-2"
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
            setUploadedAttachments([]);
          }}
          className="text-sm font-medium transition-colors"
          style={{ 
            color: 'var(--color-raycast-text-secondary)',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
});

ComposeReply.displayName = 'ComposeReply';