import { type gmail_v1 } from "googleapis";
import { db } from "../db";
import { 
  getGmailClient, 
  getUserRefreshToken, 
  extractEmailContent, 
  getHeaderValue,
  parseEmailAddresses,
  type GmailThread,
  type GmailMessage,
  type GmailLabel,
} from "../gmail";
import { uploadToS3, S3_PATHS } from "../s3";
import { type JobStatus, type SyncType } from "@prisma/client";

const BATCH_SIZE = 50;
const THREADS_PER_PAGE = 100;
const MAX_CONCURRENT_BATCHES = 5;

export class GmailSyncService {
  private gmail: gmail_v1.Gmail;
  private userId: string;
  private syncJobId: string | null = null;

  constructor(gmail: gmail_v1.Gmail, userId: string) {
    this.gmail = gmail;
    this.userId = userId;
  }

  static async create(userId: string): Promise<GmailSyncService | null> {
    const refreshToken = await getUserRefreshToken(userId);
    if (!refreshToken) return null;

    const gmail = getGmailClient(refreshToken);
    return new GmailSyncService(gmail, userId);
  }

  async syncMailbox(syncType: SyncType = "FULL"): Promise<void> {
    try {
      // Create sync job
      const syncJob = await db.syncJob.create({
        data: {
          userId: this.userId,
          status: "RUNNING",
          type: syncType,
        },
      });
      this.syncJobId = syncJob.id;

      // Update user sync status
      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: "SYNCING" },
      });

      // Sync labels first
      await this.syncLabels();

      // Sync threads
      await this.syncThreads();

      // Mark sync as completed
      await this.completeSyncJob("COMPLETED");
      
      await db.user.update({
        where: { id: this.userId },
        data: { 
          syncStatus: "COMPLETED",
          lastSyncedAt: new Date(),
        },
      });
    } catch (error) {
      console.error("Sync failed:", error);
      
      // Enhanced error logging for production
      if (error instanceof Error) {
        console.error("Error details:", {
          name: error.name,
          message: error.message,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
          userId: this.userId,
          syncJobId: this.syncJobId,
        });
      }
      
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await this.completeSyncJob("FAILED", errorMessage);
      
      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: "FAILED" },
      });
      
      // Don't throw in production to avoid killing the serverless function
      if (process.env.NODE_ENV !== 'production') {
        throw error;
      }
    }
  }

  private async completeSyncJob(status: JobStatus, error?: string): Promise<void> {
    if (!this.syncJobId) return;

    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        status,
        completedAt: new Date(),
        progress: status === "COMPLETED" ? 100 : undefined,
        error,
      },
    });
  }

  private async updateSyncProgress(processedItems: number, totalItems: number): Promise<void> {
    if (!this.syncJobId) return;

    // Fix: Ensure progress never exceeds 100% and handle estimates
    const actualTotal = Math.max(totalItems, processedItems); // Use actual count if estimate is wrong
    const progress = actualTotal > 0 ? Math.min((processedItems / actualTotal) * 100, 100) : 0;
    
    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        processedItems,
        totalItems: actualTotal, // Update with actual total
        progress: Math.round(progress), // Round to avoid decimals
      },
    });
  }

  private async syncLabels(): Promise<void> {
    const response = await this.gmail.users.labels.list({ userId: "me" });
    const labels = response.data.labels as GmailLabel[] || [];

    for (const label of labels) {
      await db.label.upsert({
        where: {
          userId_gmailLabelId: {
            userId: this.userId,
            gmailLabelId: label.id,
          },
        },
        update: {
          name: label.name,
          type: label.type === "system" ? "SYSTEM" : "USER",
          color: label.color?.backgroundColor,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
        },
        create: {
          userId: this.userId,
          gmailLabelId: label.id,
          name: label.name,
          type: label.type === "system" ? "SYSTEM" : "USER",
          color: label.color?.backgroundColor,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
        },
      });
    }
  }

  private async syncThreads(): Promise<void> {
    let pageToken: string | undefined;
    let totalThreads = 0;
    let processedThreads = 0;
    const startTime = Date.now();
    const SERVERLESS_TIMEOUT = process.env.NODE_ENV === 'development' ? 300000 : 45000; // 5min dev, 45s prod

    console.log("🔄 Starting thread sync...");

    // Check if we're resuming from a previous sync
    if (this.syncJobId) {
      const existingJob = await db.syncJob.findUnique({
        where: { id: this.syncJobId },
      });
      if (existingJob?.processedItems) {
        processedThreads = existingJob.processedItems;
        console.log(`📌 Resuming sync from ${processedThreads} processed threads`);
      }
    }

    do {
      // Check timeout before processing each page
      const elapsedTime = Date.now() - startTime;
      if (elapsedTime > SERVERLESS_TIMEOUT && pageToken) {
        console.log("⏱️ Approaching serverless timeout, saving progress...");
        
        // Save progress and nextPageToken for continuation
        if (this.syncJobId) {
          await db.syncJob.update({
            where: { id: this.syncJobId },
            data: {
              processedItems: processedThreads,
              totalItems: totalThreads,
              nextPageToken: pageToken,
              progress: Math.min((processedThreads / Math.max(totalThreads, 1)) * 100, 100),
            },
          });
        }
        
        console.log(`💾 Saved progress: ${processedThreads}/${totalThreads} threads`);
        
        // Schedule continuation in production
        await this.scheduleContinuation();
        
        return; // Exit gracefully
      }

      // Fetch threads page
      const response = await this.gmail.users.threads.list({
        userId: "me",
        maxResults: THREADS_PER_PAGE,
        pageToken,
      });

      const threads = response.data.threads || [];
      totalThreads = response.data.resultSizeEstimate || Math.max(totalThreads, processedThreads + threads.length);
      
      console.log(`📧 Processing page: ${threads.length} threads (total estimate: ${totalThreads})`);
      
      // Process threads in batches with timeout checks
      for (let i = 0; i < threads.length; i += BATCH_SIZE) {
        // Check timeout before each batch
        const batchElapsed = Date.now() - startTime;
        if (batchElapsed > SERVERLESS_TIMEOUT) {
          console.log("⏱️ Timeout during batch processing");
          return;
        }

        const batch = threads.slice(i, i + BATCH_SIZE);
        
        // Process batch concurrently
        await Promise.all(
          batch.map(thread => this.syncThread(thread.id!))
        );
        
        processedThreads += batch.length;
        await this.updateSyncProgress(processedThreads, totalThreads);
        
        // Log progress less frequently
        if (processedThreads % 50 === 0) {
          console.log(`⚡ Processed ${processedThreads}/${totalThreads} threads`);
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    
    console.log(`✅ Sync completed: ${processedThreads} threads processed`);
  }

  private async syncThread(gmailThreadId: string): Promise<void> {
    try {
      // Fetch full thread data
      const response = await this.gmail.users.threads.get({
        userId: "me",
        id: gmailThreadId,
      });

      const threadData = response.data;
      if (!threadData.messages || threadData.messages.length === 0) return;

      // Get thread metadata from the last message
      const lastMessage = threadData.messages[threadData.messages.length - 1] as GmailMessage;
      const firstMessage = threadData.messages[0] as GmailMessage;
      
      const subject = getHeaderValue(lastMessage.payload.headers, "Subject") || 
                     getHeaderValue(firstMessage.payload.headers, "Subject") || 
                     "(no subject)";
      
      // Check for INBOX label to determine if unread
      const hasInbox = lastMessage.labelIds?.includes("INBOX") ?? false;
      const isUnread = lastMessage.labelIds?.includes("UNREAD") ?? false;
      const isStarred = lastMessage.labelIds?.includes("STARRED") ?? false;
      const isImportant = lastMessage.labelIds?.includes("IMPORTANT") ?? false;

      // Upsert thread
      const thread = await db.thread.upsert({
        where: {
          userId_gmailThreadId: {
            userId: this.userId,
            gmailThreadId,
          },
        },
        update: {
          subject,
          snippet: threadData.snippet || "",
          lastMessageDate: new Date(parseInt(lastMessage.internalDate)),
          unread: isUnread,
          starred: isStarred,
          important: isImportant,
          messageCount: threadData.messages.length,
        },
        create: {
          userId: this.userId,
          gmailThreadId,
          subject,
          snippet: threadData.snippet || "",
          lastMessageDate: new Date(parseInt(lastMessage.internalDate)),
          unread: isUnread,
          starred: isStarred,
          important: isImportant,
          messageCount: threadData.messages.length,
        },
      });

      // Sync all messages in the thread
      for (const message of threadData.messages as GmailMessage[]) {
        await this.syncMessage(message, thread.id);
      }

      // Sync thread labels
      await this.syncThreadLabels(thread.id, lastMessage.labelIds || []);
    } catch (error) {
      console.error(`Failed to sync thread ${gmailThreadId}:`, error);
    }
  }

  private async syncMessage(message: GmailMessage, threadId: string): Promise<void> {
    const headers = message.payload.headers;
    const from = getHeaderValue(headers, "From");
    const to = parseEmailAddresses(getHeaderValue(headers, "To"));
    const cc = parseEmailAddresses(getHeaderValue(headers, "Cc"));
    const bcc = parseEmailAddresses(getHeaderValue(headers, "Bcc"));
    const subject = getHeaderValue(headers, "Subject") || "(no subject)";
    const date = new Date(parseInt(message.internalDate));
    const inReplyTo = getHeaderValue(headers, "In-Reply-To") || null;
    const references = parseEmailAddresses(getHeaderValue(headers, "References"));

    // Extract content
    const { html, text, attachments } = extractEmailContent(message);

    // Upload HTML to S3
    let htmlS3Key: string | null = null;
    if (html) {
      htmlS3Key = S3_PATHS.MESSAGE_HTML(this.userId, message.id);
      await uploadToS3(htmlS3Key, html, "text/html");
    }

    // Upsert message
    const savedMessage = await db.message.upsert({
      where: {
        gmailMessageId: message.id,
      },
      update: {
        snippet: message.snippet,
        htmlS3Key,
        textContent: text,
        labelIds: message.labelIds || [],
      },
      create: {
        threadId,
        gmailMessageId: message.id,
        gmailThreadId: message.threadId,
        from,
        to,
        cc,
        bcc,
        subject,
        snippet: message.snippet,
        date,
        htmlS3Key,
        textContent: text,
        inReplyTo,
        references,
        labelIds: message.labelIds || [],
      },
    });

    // Sync attachments
    for (const attachment of attachments) {
      await this.syncAttachment(savedMessage.id, message.id, attachment);
    }
  }

  private async syncAttachment(
    messageId: string, 
    gmailMessageId: string,
    attachment: {
      filename: string;
      mimeType: string;
      attachmentId: string;
      size: number;
    }
  ): Promise<void> {
    // Check if attachment already exists
    const existing = await db.attachment.findFirst({
      where: {
        messageId,
        gmailAttachmentId: attachment.attachmentId,
      },
    });

    if (existing) return;

    // Download attachment
    const response = await this.gmail.users.messages.attachments.get({
      userId: "me",
      messageId: gmailMessageId,
      id: attachment.attachmentId,
    });

    if (!response.data.data) return;

    // Upload to S3
    const s3Key = S3_PATHS.ATTACHMENT(
      this.userId, 
      gmailMessageId, 
      attachment.attachmentId,
      attachment.filename
    );
    
    const attachmentData = Buffer.from(response.data.data, "base64");
    await uploadToS3(s3Key, attachmentData, attachment.mimeType);

    // Save to database
    await db.attachment.create({
      data: {
        messageId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        s3Key,
        gmailAttachmentId: attachment.attachmentId,
      },
    });
  }

  private async syncThreadLabels(threadId: string, labelIds: string[]): Promise<void> {
    // Remove existing label associations
    await db.labelThread.deleteMany({
      where: { threadId },
    });

    // Add new label associations
    const labels = await db.label.findMany({
      where: {
        userId: this.userId,
        gmailLabelId: { in: labelIds },
      },
    });

    for (const label of labels) {
      await db.labelThread.create({
        data: {
          labelId: label.id,
          threadId,
        },
      });
    }
  }

  private async scheduleContinuation(): Promise<void> {
    // Only in production/serverless environments
    if (!process.env.VERCEL_URL && process.env.NODE_ENV !== 'production') {
      return;
    }

    try {
      console.log("📅 Scheduling sync continuation...");
      
      const continueUrl = `${process.env.VERCEL_URL || 'http://localhost:3000'}/api/sync/continue`;
      
      // Schedule with a small delay to ensure current process completes
      setTimeout(() => {
        fetch(continueUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.CRON_SECRET || 'development'}`,
          },
          body: JSON.stringify({
            userId: this.userId,
          }),
        })
        .then(response => {
          if (response.ok) {
            console.log("✅ Sync continuation scheduled");
          } else {
            console.error("❌ Failed to schedule continuation:", response.status);
          }
        })
        .catch(error => {
          console.error("❌ Error scheduling continuation:", error);
        });
      }, 2000); // 2 second delay

    } catch (error) {
      console.error("Failed to schedule continuation:", error);
    }
  }
}