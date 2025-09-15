"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import { SendIcon, PaperclipIcon, SparklesIcon, XIcon, ArrowLeftIcon } from "lucide-react";
import { cn } from "~/lib/utils";

export function ComposeEmail() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploadedAttachments, setUploadedAttachments] = useState<{id: string, s3Key: string, filename: string}[]>([]);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [isForward, setIsForward] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Get original message content for forwarding
  const originalMessageId = searchParams.get('originalMessageId');
  const { data: originalContent } = api.gmail.getMessageContent.useQuery(
    { messageId: originalMessageId! },
    { enabled: !!originalMessageId }
  );

  // Handle forward parameters
  useEffect(() => {
    const type = searchParams.get('type');
    if (type === 'forward') {
      setIsForward(true);
      const originalSubject = searchParams.get('originalSubject');
      const originalFrom = searchParams.get('originalFrom');
      const originalDate = searchParams.get('originalDate');
      
      if (originalSubject) {
        setSubject(`Fwd: ${originalSubject}`);
      }
      
      // Set initial content with forwarded message header
      if (originalFrom && originalDate) {
        const forwardHeader = `\n\n---------- Forwarded message ----------\nFrom: ${originalFrom}\nDate: ${new Date(originalDate).toLocaleString()}\nSubject: ${originalSubject}\n\n`;
        setContent(forwardHeader);
      }
    }
  }, [searchParams]);

  // Update content when original message content loads
  useEffect(() => {
    if (isForward && originalContent) {
      const originalSubject = searchParams.get('originalSubject');
      const originalFrom = searchParams.get('originalFrom');
      const originalDate = searchParams.get('originalDate');
      
      const forwardHeader = `\n\n---------- Forwarded message ----------\nFrom: ${originalFrom}\nDate: ${new Date(originalDate!).toLocaleString()}\nSubject: ${originalSubject}\n\n`;
      const messageContent = originalContent.text || originalContent.html?.replace(/<[^>]*>/g, '') || '';
      setContent(forwardHeader + messageContent);
    }
  }, [originalContent, isForward, searchParams]);

  const utils = api.useUtils();
  const uploadAttachment = api.gmail.uploadAttachment.useMutation();
  const sendEmail = api.gmail.sendReply.useMutation({
    onSuccess: (data) => {
      // Invalidate all relevant caches to show the sent message immediately
      void utils.gmail.getThreads.invalidate();
      router.push("/dashboard");
    },
    onError: (error) => {
      console.error("Send failed:", error);
    },
  });

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
      const bccEmails = bcc ? cleanEmails(bcc) : [];

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

      await sendEmail.mutateAsync({
        threadId: "", // Empty string for new emails
        to: toEmails,
        cc: ccEmails,
        bcc: bccEmails,
        subject: subject || "(no subject)",
        content,
        attachmentKeys,
        attachments: attachmentMetadata,
      });
    } catch (error) {
      console.error("Send failed:", error);
      alert(error instanceof Error ? error.message : "Failed to send email");
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

  const handleDiscard = () => {
    // Show confirmation if there's content
    if (to.trim() || cc.trim() || bcc.trim() || subject.trim() || content.trim()) {
      if (confirm("Discard this draft?")) {
        router.push("/dashboard");
      }
    } else {
      router.push("/dashboard");
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--color-raycast-bg-secondary)' }}>
      {/* Header */}
      <div className="p-6" style={{ 
        backgroundColor: 'var(--color-raycast-surface)', 
        borderBottom: '1px solid var(--color-raycast-border-light)' 
      }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className="raycast-button p-2"
              title="Back"
            >
              <ArrowLeftIcon className="w-5 h-5" />
            </button>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--color-raycast-text)' }}>
              {isForward ? 'Forward Message' : 'New Message'}
            </h1>
          </div>
          <button
            onClick={handleDiscard}
            className="text-sm font-medium transition-colors"
            style={{ color: 'var(--color-raycast-text-secondary)' }}
          >
            Discard
          </button>
        </div>
      </div>

      {/* Compose Form */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="raycast-card max-w-4xl mx-auto p-6 space-y-4">
          <div className="space-y-3">
            {/* To Field */}
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
                autoFocus
              />
              <button
                onClick={() => setShowCcBcc(!showCcBcc)}
                className="text-sm text-blue-600 hover:text-blue-800 transition-colors"
              >
                {showCcBcc ? "Hide" : "Cc/Bcc"}
              </button>
            </div>

            {/* Cc Field */}
            {showCcBcc && (
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
            )}

            {/* Bcc Field */}
            {showCcBcc && (
              <div className="flex gap-3 items-center">
                <label className="text-sm font-medium w-16" style={{ color: 'var(--color-raycast-text-secondary)' }}>
                  Bcc:
                </label>
                <input
                  type="text"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="Bcc recipients (optional)"
                  className="raycast-input flex-1"
                />
              </div>
            )}

            {/* Subject Field */}
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

          {/* Content Area */}
          <div className="relative">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Compose your message..."
              rows={12}
              className="raycast-input resize-none"
              style={{ minHeight: '300px' }}
            />
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
          <div className="flex items-center justify-between pt-4" style={{ borderTop: '1px solid var(--color-raycast-border-light)' }}>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSend}
                disabled={sendEmail.isPending || uploadAttachment.isPending || !to.trim() || !content.trim()}
                className="raycast-button primary gap-2 disabled:opacity-50"
              >
                <SendIcon className="w-4 h-4" />
                {uploadAttachment.isPending ? "Uploading..." : sendEmail.isPending ? "Sending..." : "Send"}
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

            <div className="text-xs" style={{ color: 'var(--color-raycast-text-tertiary)' }}>
              Ctrl+Enter to send
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}